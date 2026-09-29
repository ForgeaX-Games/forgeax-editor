import type { RuntimeAssetBinding } from '@forgeax/engine-types';
import { studioBootTrace } from './studio-boot-trace';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 250;

export type ScopedCatalogWaitResult =
  | { readonly ok: true; readonly effectiveGeneration?: number }
  | { readonly ok: false; readonly message: string; readonly lastStatus?: number; readonly lastBody?: string };

function packRouteErrorCode(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const error = (body as { error?: unknown }).error;
  return typeof error === 'string' ? error : undefined;
}

/** Scan failures do not self-heal by polling; only scope startup / watcher settle does. */
function isTransientPackRouteFailure(status: number, body: unknown): boolean {
  const error = packRouteErrorCode(body);
  if (status === 404) {
    // Studio Play returns this until orchestrator POST /__pack/control/bind lands.
    return error === 'runtime-scope-unbound';
  }
  if (status === 503) {
    if (error === 'scan-failed' || error === 'produce-failed') return false;
    if (error === 'runtime-scope-unavailable'
      || error === 'watch-failed'
      || error === 'runtime-session-unavailable'
      || error === 'producer-not-ready'
      || error === 'runtime-scope-unbound') {
      return true;
    }
    return error === undefined;
  }
  if (status === 422) return true;
  return false;
}

function formatScanFailedMessage(body: unknown): string {
  const serialized = JSON.stringify(body);
  const legacyPack = serialized.includes('authoring source schema is unsupported')
    || serialized.includes('schemaVersion')
    && serialized.includes('1.0.0');
  if (legacyPack) {
    return [
      'Pack catalog scan failed: a ScriptablePack source still uses schemaVersion 1.0.0',
      '(for example assets/resonance-forge.pack.ts).',
      'Rebuild engine-pack dist after pulling engine fixes',
      '(pnpm --filter @forgeax/engine-pack run build under packages/editor/packages/engine),',
      'restart Studio (bun fx stop && bun fx start), or migrate/remove the legacy .pack.ts.',
    ].join(' ');
  }
  return 'Pack catalog scan failed (scan-failed). Inspect the Play (:15173) terminal for catalog-scan-failed diagnostics, repair assets, rebuild engine-pack if needed, then restart Studio.';
}

function formatProduceFailedMessage(body: unknown): string {
  const serialized = JSON.stringify(body);
  const nativeCook = serialized.includes('native-cook-failed');
  if (nativeCook) {
    return [
      'Pack production failed during startup import (produce-failed / native-cook).',
      'Play uses producerReadiness on-demand so authored scene packs can load without importing template sfx first.',
      'Restart Studio after pulling play-runtime vite changes; if this persists, inspect Play (:15173) logs for the failing meta path.',
    ].join(' ');
  }
  return 'Pack production failed (produce-failed). Inspect the Play (:15173) terminal, repair the cited source, then restart Studio.';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function rewriteScopeGenerationInUrl(
  url: string,
  scopeId: string,
  generation: number,
): string {
  const marker = `/scopes/${scopeId}/`;
  const start = url.indexOf(marker);
  if (start < 0) return url;
  const generationStart = start + marker.length;
  const generationEnd = url.indexOf('/', generationStart);
  if (generationEnd < 0) return url;
  return (
    url.slice(0, generationStart)
    + String(generation)
    + url.slice(generationEnd)
  );
}

/** Keep Pack transport URLs aligned after Play bumps runtime scope generation. */
export function applyRuntimeScopeGeneration(
  binding: RuntimeAssetBinding,
  generation: number,
): RuntimeAssetBinding {
  if (binding.generation === generation) return binding;
  return {
    ...binding,
    generation,
    catalogUrl: rewriteScopeGenerationInUrl(binding.catalogUrl, binding.scopeId, generation),
    importUrlBase: rewriteScopeGenerationInUrl(binding.importUrlBase, binding.scopeId, generation),
    packageUrlBase: rewriteScopeGenerationInUrl(binding.packageUrlBase, binding.scopeId, generation),
  };
}

/**
 * Poll the host-authoritative scoped catalog URL until the Pack producer has
 * finished startup (same contract as hello-taa smoke `waitForScopedPackCatalog`).
 * Avoids racing `loadByGuid` against a deliberate fail-closed 503.
 */
export async function waitForScopedPackCatalog(
  binding: Pick<RuntimeAssetBinding, 'catalogUrl' | 'scopeId' | 'generation'>,
  isActive: () => boolean,
  options?: { timeoutMs?: number; pollMs?: number },
): Promise<ScopedCatalogWaitResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options?.pollMs ?? DEFAULT_POLL_MS;
  const url = binding.catalogUrl.trim();
  if (url.length === 0) {
    return { ok: false, message: 'scoped catalog URL is empty' };
  }

  const startedAt = Date.now();
  let lastStatus: number | undefined;
  let lastBody: string | undefined;
  let polls = 0;
  let activeBinding: Pick<RuntimeAssetBinding, 'catalogUrl' | 'scopeId' | 'generation'> = {
    ...binding,
  };
  studioBootTrace('catalog.wait.begin', {
    catalogUrl: activeBinding.catalogUrl,
    scopeId: activeBinding.scopeId,
    generation: activeBinding.generation,
    timeoutMs,
  });

  while (Date.now() - startedAt < timeoutMs) {
    if (!isActive()) {
      studioBootTrace('catalog.wait.aborted', { reason: 'boot-superseded', polls });
      return { ok: false, message: 'viewport boot superseded while waiting for scoped catalog' };
    }
    polls += 1;
    const fetchUrl = activeBinding.catalogUrl.trim();
    try {
      const response = await fetch(fetchUrl, { cache: 'no-store' });
      lastStatus = response.status;
      const text = await response.text();
      lastBody = text.slice(0, 512);
      if (response.ok) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return {
            ok: false,
            message: 'scoped catalog returned invalid JSON',
            lastStatus,
            lastBody,
          };
        }
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const snapshot = parsed as {
            scopeId?: unknown;
            generation?: unknown;
            authority?: unknown;
            entries?: unknown;
            diagnostics?: unknown;
          };
          if (
            typeof snapshot.scopeId === 'string'
            && snapshot.scopeId !== activeBinding.scopeId
          ) {
            return {
              ok: false,
              message: `scoped catalog scopeId mismatch (expected ${activeBinding.scopeId}, got ${snapshot.scopeId})`,
              lastStatus,
              lastBody,
            };
          }
          if (
            typeof snapshot.generation === 'number'
            && snapshot.generation !== activeBinding.generation
          ) {
            return {
              ok: false,
              message: `scoped catalog generation mismatch (expected ${activeBinding.generation}, got ${snapshot.generation})`,
              lastStatus,
              lastBody,
            };
          }
          if (snapshot.authority === 'degraded') {
            const entryCount = Array.isArray(snapshot.entries) ? snapshot.entries.length : 0;
            if (entryCount === 0) {
              return {
                ok: false,
                message: [
                  'scoped catalog is degraded with no discoverable entries.',
                  'Inspect Play (:15173) logs for catalog diagnostics, repair broken assets under the game folder, then restart Studio.',
                ].join(' '),
                lastStatus,
                lastBody: text.slice(0, 2048),
              };
            }
          }
        }
        studioBootTrace('catalog.wait.ready', {
          polls,
          elapsedMs: Date.now() - startedAt,
          generation: activeBinding.generation,
        });
        return {
          ok: true,
          ...(activeBinding.generation !== binding.generation
            ? { effectiveGeneration: activeBinding.generation }
            : {}),
        };
      }
      let bodyJson: unknown;
      try {
        bodyJson = JSON.parse(text);
      } catch {
        bodyJson = undefined;
      }
      const routeError = packRouteErrorCode(bodyJson);
      if (routeError === 'scan-failed') {
        return {
          ok: false,
          message: formatScanFailedMessage(bodyJson),
          lastStatus,
          lastBody: text.slice(0, 2048),
        };
      }
      if (routeError === 'produce-failed') {
        return {
          ok: false,
          message: formatProduceFailedMessage(bodyJson),
          lastStatus,
          lastBody: text.slice(0, 2048),
        };
      }
      if (response.status === 410) {
        const routeError = packRouteErrorCode(bodyJson);
        const currentGeneration =
          bodyJson !== null
          && typeof bodyJson === 'object'
          && typeof (bodyJson as { currentGeneration?: unknown }).currentGeneration === 'number'
            ? (bodyJson as { currentGeneration: number }).currentGeneration
            : undefined;
        if (
          routeError === 'runtime-scope-generation-expired'
          && currentGeneration !== undefined
          && Number.isSafeInteger(currentGeneration)
          && currentGeneration !== activeBinding.generation
        ) {
          studioBootTrace('catalog.wait.generation-follow', {
            from: activeBinding.generation,
            to: currentGeneration,
          });
          activeBinding = {
            ...activeBinding,
            generation: currentGeneration,
            catalogUrl: rewriteScopeGenerationInUrl(
              activeBinding.catalogUrl,
              activeBinding.scopeId,
              currentGeneration,
            ),
          };
          await sleep(pollMs);
          continue;
        }
        return {
          ok: false,
          message: 'scoped catalog generation expired (HTTP 410)',
          lastStatus,
          lastBody,
        };
      }
      if (response.status === 404 && routeError === 'runtime-scope-not-found') {
        return {
          ok: false,
          message: 'scoped catalog scope is not registered on Play (HTTP 404)',
          lastStatus,
          lastBody,
        };
      }
      if (!isTransientPackRouteFailure(response.status, bodyJson)) {
        studioBootTrace('catalog.wait.fail', {
          polls,
          message: `scoped catalog request failed (HTTP ${response.status})`,
          lastStatus,
          routeError: packRouteErrorCode(bodyJson),
        });
        return {
          ok: false,
          message: `scoped catalog request failed (HTTP ${response.status})`,
          lastStatus,
          lastBody,
        };
      }
    } catch (error) {
      lastBody = error instanceof Error ? error.message : String(error);
    }
    if (polls === 1 || polls % 20 === 0) {
      studioBootTrace('catalog.poll', {
        polls,
        elapsedMs: Date.now() - startedAt,
        lastStatus,
        lastBodyPreview: lastBody?.slice(0, 160),
      });
    }
    await sleep(pollMs);
  }

  studioBootTrace('catalog.wait.timeout', { polls, timeoutMs, lastStatus });
  return {
    ok: false,
    message: `scoped catalog did not become ready within ${timeoutMs}ms`,
    lastStatus,
    lastBody,
  };
}
