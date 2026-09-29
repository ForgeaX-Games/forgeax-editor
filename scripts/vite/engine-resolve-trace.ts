import type { PluginOption } from 'vite';

/** Set `FORGEAX_ENGINE_RESOLVE_TRACE=0` to silence Vite client resolve breadcrumbs. */
export function isEngineResolveTraceEnabled(): boolean {
  return process.env.FORGEAX_ENGINE_RESOLVE_TRACE !== '0';
}

const WATCHED_SPECIFIERS = [
  '@forgeax/engine-import',
  '@forgeax/engine-pack/build',
  '@forgeax/engine-pack/build-node',
  '@forgeax/engine-pack/source-node',
  '@forgeax/engine-pack/cli-asset',
  '@forgeax/engine-ddc',
] as const;

const RISKY_PATH_RE =
  /scriptable-pack-node-impl|build-production|scanner-node-impl|cli-asset|node:fs|node:crypto|import-node-client-stub|ddc-node-client-stub/i;

function shortenImporter(importer: string | undefined): string | undefined {
  if (importer === undefined) return undefined;
  const norm = importer.replace(/\\/g, '/');
  const idx = norm.indexOf('/packages/');
  return idx >= 0 ? norm.slice(idx) : norm.slice(-120);
}

export function shouldTraceEngineResolve(id: string, resolved?: string | null): boolean {
  if (!isEngineResolveTraceEnabled()) return false;
  if (WATCHED_SPECIFIERS.some((spec) => id === spec || id.startsWith(`${spec}/`))) {
    return true;
  }
  const probe = `${id}\0${resolved ?? ''}`;
  return RISKY_PATH_RE.test(probe);
}

export function logEngineResolve(
  host: string,
  tag: string,
  detail: Record<string, unknown>,
): void {
  if (!isEngineResolveTraceEnabled()) return;
  console.log(`[forgeax:engine-resolve:${host}:${tag}]`, detail);
}

/** Post-resolve audit: logs final client resolution for risky @forgeax engine imports. */
export function engineClientResolveTracePlugin(hostLabel: string): PluginOption {
  return {
    name: `forgeax:engine-client-resolve-trace:${hostLabel}`,
    enforce: 'post',
    async resolveId(id, importer, options) {
      if (options?.ssr === true) return null;
      if (!shouldTraceEngineResolve(id)) return null;
      let resolved: string | null = null;
      try {
        resolved = (await this.resolve(id, importer, { ...options, skipSelf: true })) ?? null;
      } catch (err) {
        logEngineResolve(hostLabel, 'resolve-failed', {
          id,
          importer: shortenImporter(importer),
          err: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
      const norm = resolved?.replace(/\\/g, '/');
      const risky = norm !== undefined && RISKY_PATH_RE.test(norm);
      logEngineResolve(hostLabel, risky ? 'final-RISKY' : 'final', {
        id,
        resolved: norm,
        importer: shortenImporter(importer),
      });
      return null;
    },
  };
}
