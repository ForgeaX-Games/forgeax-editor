// Opt-in trace for infinite-grid visibility vs view-bind-group readiness.
// Enable: localStorage.setItem('forgeax.trace.infiniteGrid', '1') then reload.

export const INFINITE_GRID_VISIBILITY_TRACE_KEY = 'forgeax.trace.infiniteGrid';

export function isInfiniteGridVisibilityTraceEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(INFINITE_GRID_VISIBILITY_TRACE_KEY) === '1';
  } catch {
    return false;
  }
}

export type InfiniteGridVisibilityTracePayload = Readonly<{
  visible: boolean;
  gridVisible: boolean;
  display: string;
  playPhase: string;
  sceneWorldDefined: boolean;
  ecsMeshEntities: number;
  frustumStats: { readonly culled: number; readonly total: number } | null;
  sceneHasViewBindGroupSupport: boolean;
  renderFeatureHealthy: boolean;
  reason: string;
}>;

let lastTraceSignature = '';

export function traceInfiniteGridVisibility(payload: InfiniteGridVisibilityTracePayload): void {
  if (!isInfiniteGridVisibilityTraceEnabled()) return;
  const signature = JSON.stringify({
    visible: payload.visible,
    reason: payload.reason,
    frustum: payload.frustumStats,
    ecsMeshEntities: payload.ecsMeshEntities,
    sceneWorldDefined: payload.sceneWorldDefined,
    healthy: payload.renderFeatureHealthy,
  });
  if (signature === lastTraceSignature) return;
  lastTraceSignature = signature;
  console.info('[editor][infinite-grid-visibility]', payload);
}

export function resetInfiniteGridVisibilityTraceForTests(): void {
  lastTraceSignature = '';
}

export function traceInfiniteGridRendererError(
  error: unknown,
  context: Readonly<{
    frustumStats: { readonly culled: number; readonly total: number } | null;
    featureStatus: string | null;
    featureLatestError: unknown;
  }>,
): void {
  if (!isInfiniteGridVisibilityTraceEnabled()) return;
  const code = error !== null && typeof error === 'object' && 'code' in error
    ? String((error as { readonly code: unknown }).code)
    : 'unknown';
  if (code !== 'device-operation-failed') return;
  console.warn('[editor][infinite-grid-render-error]', {
    code,
    message: error instanceof Error ? error.message : String(error),
    ...context,
  });
}
