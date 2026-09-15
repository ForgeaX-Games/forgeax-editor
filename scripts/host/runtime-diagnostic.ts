import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface RuntimeDiagnosticAlias {
  readonly path: string;
  readonly projectPath: string;
}

/** Snapshot aliases before a failed mount can roll back to another project. */
export function resolveRuntimeDiagnosticAliases(gameRoot: string, roots: readonly string[]): readonly RuntimeDiagnosticAlias[] {
  const project = realpathSync(gameRoot);
  const aliases: RuntimeDiagnosticAlias[] = [];
  for (const root of roots) {
    try {
      const target = realpathSync(root);
      const path = relative(project, target);
      if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) continue;
      aliases.push({ path: resolve(root), projectPath: path ? `./${path.split(sep).join('/')}` : '.' });
    } catch { /* Missing or unresolvable roots have no verified project identity. */ }
  }
  return aliases;
}

/** Project-relative projection of the producer's structured diagnostic contract.
 * Arbitrary Error.message/stack are deliberately excluded. */
export function projectRuntimeDiagnostic(error: unknown, gameRoot?: string, aliases: readonly RuntimeDiagnosticAlias[] = [], causeDepth = 0, causeBudget = { remaining: 100 }): Record<string, unknown> {
  if (causeDepth > 8) return { code: 'diagnostic-depth-exceeded' };
  if (causeBudget.remaining-- <= 0) return { code: 'diagnostic-limit-exceeded' };
  const seen = new Set<object>();
  const text = (value: string): string => {
    let result = value;
    const prefixes = [...aliases, ...(gameRoot ? [{ path: gameRoot, projectPath: '.' }] : [])]
      .sort((left, right) => right.path.length - left.path.length);
    for (const alias of prefixes) {
      for (const path of new Set([alias.path, alias.path.replace(/\\/g, '/')])) {
        const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        result = result.replace(new RegExp(escaped + "(?=$|[\\\\/\\s\"'<>;,):])", 'g'), () => alias.projectPath);
      }
    }
    return result.replace(/https?:\/\/[^\s"<>]+/gi, '<url>')
      .replace(/(?:[A-Za-z]:[\\/]|\/(?:Users|home|private|tmp|var|etc)\/)[^\s"<>;,)]*/g, '<external-path>')
      .replace(/(?:bearer\s+|(?:token|secret|password|api[_-]?key)\s*[=:]\s*)[^\s;,]+/gi, '<redacted>');
  };
  const value = (input: unknown, depth: number): unknown => {
    if (depth > 8) return '<truncated>';
    if (typeof input === 'string') return text(input);
    if (input === null || typeof input === 'number' || typeof input === 'boolean') return input;
    if (!input || typeof input !== 'object' || seen.has(input)) return undefined;
    seen.add(input);
    if (Array.isArray(input)) return input.slice(0, 100).map((entry) => value(entry, depth + 1));
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(input)) {
      if (/stack|secret|token|password|authorization|cookie|credential|api.?key|environment|^env$/i.test(key)) continue;
      const projected = value(child, depth + 1);
      if (projected !== undefined) result[key] = projected;
    }
    return result;
  };
  const projectCause = (input: unknown, depth: number): unknown => {
    if (depth > 8) return { code: 'diagnostic-depth-exceeded' };
    if (Array.isArray(input)) {
      if (causeBudget.remaining-- <= 0) return [];
      return input.slice(0, causeBudget.remaining).map((entry) => projectCause(entry, depth + 1));
    }
    return projectRuntimeDiagnostic(input, gameRoot, aliases, depth, causeBudget);
  };
  if (error === null || typeof error !== 'object') return { code: 'runtime-scope-bind-failed' };
  const source = error as Record<string, unknown>;
  const diagnostic: Record<string, unknown> = {};
  for (const key of ['code', 'expected', 'hint', 'detail', 'cause'] as const) {
    const projected = key === 'cause' && source[key] !== undefined
      ? projectCause(source[key], causeDepth + 1)
      : value(source[key], 0);
    if (projected !== undefined) diagnostic[key] = projected;
  }
  if (typeof diagnostic.code !== 'string') diagnostic.code = 'runtime-scope-bind-failed';
  return diagnostic;
}
