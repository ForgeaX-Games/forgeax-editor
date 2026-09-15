import { PlayBindingFailure } from './boot-diagnostic';
import {
  isRuntimeCatalogRoots,
  type RuntimeAssetBinding,
} from '@forgeax/engine-types';

export const RUNTIME_BINDING_MAX_WAIT_MS = 30_000;
export const RUNTIME_BINDING_RETRY_DELAY_MS = 100;
export const RUNTIME_BINDING_REQUEST_TIMEOUT_MS = 2_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RuntimeBindingLoaderOptions {
  readonly expected?: { gameId: string; scopeId: string; generation: number };
  readonly maxWaitMs?: number;
  readonly retryDelayMs?: number;
  readonly requestTimeoutMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function asRuntimeAssetBinding(value: unknown): RuntimeAssetBinding | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const candidate = value as Partial<RuntimeAssetBinding>;
  if (
    candidate.schemaVersion !== 'runtime-asset-binding-v1'
    || typeof candidate.gameId !== 'string'
    || typeof candidate.scopeId !== 'string'
    || !Number.isSafeInteger(candidate.generation)
    || (candidate.status !== 'ready' && candidate.status !== 'degraded')
    || typeof candidate.catalogUrl !== 'string'
    || typeof candidate.importUrlBase !== 'string'
    || typeof candidate.packageUrlBase !== 'string'
    || (candidate.catalogRoots !== undefined && !isRuntimeCatalogRoots(candidate.catalogRoots))
  ) {
    return undefined;
  }
  return candidate as RuntimeAssetBinding;
}

/**
 * Resolve the server-published binding without making the Play carrier guess
 * how long a cold Vite/Pack startup needs. Each request has its own deadline,
 * while the overall deadline leaves room for a slow first transform or a
 * transient server restart. `unbound` remains the explicit empty-game signal.
 */
export async function loadRuntimeBinding(
  bindingUrl: string,
  fetchImpl: FetchLike,
  options: RuntimeBindingLoaderOptions = {},
): Promise<RuntimeAssetBinding | undefined> {
  const maxWaitMs = options.maxWaitMs ?? RUNTIME_BINDING_MAX_WAIT_MS;
  const retryDelayMs = options.retryDelayMs ?? RUNTIME_BINDING_RETRY_DELAY_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? RUNTIME_BINDING_REQUEST_TIMEOUT_MS;
  const wait = options.sleep ?? sleep;
  const startedAt = Date.now();
  let attempts = 0;
  let lastFailure = 'no response';

  while (Date.now() - startedAt < maxWaitMs) {
    attempts += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchImpl(bindingUrl, { cache: 'no-store', signal: controller.signal });
      const body = await response.json().catch(() => null) as unknown;
      const state = body !== null && typeof body === 'object' ? body as Record<string, unknown> : undefined;
      const expected = options.expected;
      const matches = !expected || (state?.gameId === expected.gameId && state?.scopeId === expected.scopeId && state?.generation === expected.generation);
      // A known producer failure is not evidence of a slow first frame. Ignore
      // diagnostics from any other binding; they do not describe this attempt.
      if (matches && state?.status !== 'transitioning') {
        const blocking = Array.isArray(state?.diagnostics)
          ? state.diagnostics.find((item: unknown) => item !== null && typeof item === 'object' && (item as { severity?: unknown }).severity === 'blocking') : undefined;
        if (blocking) throw new PlayBindingFailure(blocking);
        if (response.status === 503 && state?.diagnostic && state.status === 'unavailable') {
          throw new PlayBindingFailure(state.diagnostic);
        }
      }
      if (response.ok && !matches) throw new PlayBindingFailure({ code: 'play-runtime-scope-stale', hint: 'The requested runtime binding has changed; start a new Play attempt.' });
      if (response.status === 503) {
        if (
          body !== null
          && typeof body === 'object'
          && (body as { status?: unknown }).status === 'unbound'
        ) {
          return undefined;
        }
        lastFailure = `HTTP 503 ${
          body !== null && typeof body === 'object' && typeof (body as { status?: unknown }).status === 'string'
            ? (body as { status: string }).status
            : 'unavailable'
        }`;
      } else if (!response.ok) {
        lastFailure = `HTTP ${response.status}`;
      } else {
        const binding = asRuntimeAssetBinding(body);
        if (binding !== undefined) return binding;
        lastFailure = `HTTP ${response.status} invalid binding payload`;
      }
    } catch (error) {
      if (error instanceof PlayBindingFailure) throw error;
      lastFailure = errorMessage(error);
    } finally {
      clearTimeout(timeout);
    }

    const remaining = maxWaitMs - (Date.now() - startedAt);
    if (remaining <= 0) break;
    await wait(Math.min(retryDelayMs, remaining));
  }

  throw new Error(
    `[engine] no authoritative runtime asset binding became ready after ${attempts} probes (${lastFailure})`,
  );
}
