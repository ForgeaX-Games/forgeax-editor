// wait-host-catalog.ts — poll the host pack producer until catalog has entries.
//
// The standalone host and edit-runtime each run their own Vite pack producer.
// Cold-starting both concurrently contends for CPU and can leave the host catalog
// stuck in `503 runtime-scope-unavailable`. Secondary services should wait here
// after the host vite is listening.

import { basename } from 'node:path';

export type WaitHostCatalogOptions = {
  readonly hostPort: number;
  readonly scopeId?: string;
  /** Absolute game root; required when the orchestrator does not inherit child env. */
  readonly gameDir?: string;
  readonly generation?: string;
  /** When set, every listed sourcePath must appear in catalog entries before ready. */
  readonly requiredSourcePaths?: readonly string[];
  /** When true with requiredSourcePaths, each required row must expose packageUrl. */
  readonly requirePublishedPackageUrls?: boolean;
  /** Carrier base path prefix, e.g. `/editor` for edit-runtime. */
  readonly basePath?: string;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly log?: (message: string) => void;
};

/** Resolve the host pack scope the spawned Vite child will publish. */
export function resolveHostCatalogScope(input: {
  readonly scopeId?: string;
  readonly gameDir?: string;
} = {}): string | undefined {
  if (input.scopeId !== undefined && input.scopeId.length > 0) return input.scopeId;
  const fromEnv = process.env.FORGEAX_RUNTIME_SCOPE_ID;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const gameDir = input.gameDir ?? process.env.FORGEAX_GAME_DIR;
  if (gameDir !== undefined && gameDir.length > 0) {
    const gameId = process.env.FORGEAX_GAME_ID ?? basename(gameDir);
    return `standalone-${gameId}`;
  }
  return undefined;
}

function resolveScopeId(scopeId: string | undefined, gameDir?: string): string {
  const resolved = resolveHostCatalogScope({ scopeId, gameDir });
  if (resolved !== undefined) return resolved;
  const gameId = process.env.FORGEAX_GAME_ID ?? 'standalone';
  return `standalone-${gameId}`;
}

function catalogUrl(options: WaitHostCatalogOptions): string {
  const scopeId = resolveScopeId(options.scopeId, options.gameDir);
  const generation = options.generation ?? process.env.FORGEAX_RUNTIME_GENERATION ?? '1';
  const basePath = options.basePath ?? '';
  return `http://127.0.0.1:${options.hostPort}${basePath}/__pack/scopes/${encodeURIComponent(scopeId)}/${generation}/catalog.json`;
}

function catalogEntries(body: unknown): Array<{ readonly sourcePath?: unknown; readonly packageUrl?: unknown }> {
  if (body === null || typeof body !== 'object') return [];
  const entries = (body as { entries?: unknown }).entries;
  return Array.isArray(entries)
    ? entries.filter((entry): entry is { readonly sourcePath?: unknown; readonly packageUrl?: unknown } => entry !== null && typeof entry === 'object')
    : [];
}

function catalogEntryCount(body: unknown): number {
  return catalogEntries(body).length;
}

function catalogHasRequiredSources(
  body: unknown,
  requiredSourcePaths: readonly string[],
  requirePublishedPackageUrls: boolean,
): boolean {
  if (catalogEntryCount(body) === 0) return false;
  if (requiredSourcePaths.length === 0) return true;
  const entries = catalogEntries(body);
  return requiredSourcePaths.every((sourcePath) => {
    const entry = entries.find((row) => row.sourcePath === sourcePath);
    if (entry === undefined) return false;
    if (!requirePublishedPackageUrls) return true;
    return typeof entry.packageUrl === 'string' && entry.packageUrl.length > 0;
  });
}

/** Poll until the host publishes a non-empty scoped catalog. */
export async function waitForHostCatalogReady(options: WaitHostCatalogOptions): Promise<void> {
  const url = catalogUrl(options);
  const timeoutMs = options.timeoutMs ?? 90_000;
  const pollMs = options.pollMs ?? 1_000;
  const log = options.log ?? (() => {});
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'pending';
  let lastBody = '';
  let polls = 0;
  const progressEveryPolls = Math.max(1, Math.floor(10_000 / pollMs));

  while (Date.now() < deadline) {
    polls += 1;
    try {
      const response = await fetch(url);
      const text = await response.text();
      lastBody = text;
      if (response.ok) {
        let body: unknown;
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          lastStatus = 'invalid-json';
        }
        const count = catalogEntryCount(body);
        const required = options.requiredSourcePaths ?? [];
        const requirePublished = options.requirePublishedPackageUrls === true;
        if (catalogHasRequiredSources(body, required, requirePublished)) {
          log(`host catalog ready (${count} entries${required.length > 0 ? `, required=${required.join(',')}` : ''}${requirePublished ? ', published' : ''}) → ${url}`);
          return;
        }
        lastStatus = required.length > 0
          ? (requirePublished ? 'missing-required-publications' : 'missing-required-sources')
          : (count === 0 ? 'empty' : `entries=${count}`);
      } else {
        lastStatus = `HTTP ${response.status}${text.length > 0 ? `: ${text.slice(0, 800)}` : ''}`;
      }
    } catch (error: unknown) {
      lastStatus = error instanceof Error ? error.message : String(error);
    }
    if (polls === 1 || polls % progressEveryPolls === 0) {
      const elapsedSec = Math.floor((Date.now() - (deadline - timeoutMs)) / 1_000);
      log(`host catalog pending (${elapsedSec}s, ${lastStatus}) → ${url}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
  }

  throw new Error(
    `timed out waiting for host catalog (${lastStatus}) → ${url}`
    + (lastBody.length > 0 ? `\nlast body: ${lastBody.slice(0, 800)}` : ''),
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Bash wrapper: poll catalog, then exec the inner command (Playwright webServer / fx bg). */
export function shellWaitThenExec(innerCommand: string, options: WaitHostCatalogOptions): string {
  const url = catalogUrl(options);
  const required = options.requiredSourcePaths ?? [];
  const requirePublished = options.requirePublishedPackageUrls === true;
  const requiredLiteral = required.map((sourcePath) => JSON.stringify(sourcePath)).join(',');
  const pythonCheck = required.length > 0
    ? requirePublished
      ? `import sys,json; d=json.load(sys.stdin); entries=d.get('entries') or []; required=[${requiredLiteral}]; ok=all(any(isinstance(e,dict) and e.get('sourcePath')==p and e.get('packageUrl') for e in entries) for p in required); sys.exit(0 if entries and ok else 1)`
      : `import sys,json; d=json.load(sys.stdin); entries=d.get('entries') or []; paths={e.get('sourcePath') for e in entries if isinstance(e,dict)}; required=[${requiredLiteral}]; sys.exit(0 if entries and all(p in paths for p in required) else 1)`
    : 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get(\'entries\') else 1)';
  const script = `until curl -sf ${shellQuote(url)} | python3 -c ${shellQuote(pythonCheck)}; do sleep 1; done; exec ${innerCommand}`;
  return script;
}

/** Poll until an HTTP URL responds with a 2xx status. */
export async function waitForHttpReady(
  url: string,
  options: {
    readonly timeoutMs?: number;
    readonly pollMs?: number;
    readonly log?: (message: string) => void;
  } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const pollMs = options.pollMs ?? 500;
  const log = options.log ?? (() => {});
  const deadline = Date.now() + timeoutMs;
  let lastError = 'unreachable';

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) {
        log(`HTTP ready → ${url}`);
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
  }

  throw new Error(`timed out waiting for HTTP ready (${timeoutMs}ms): ${url} (last: ${lastError})`);
}
