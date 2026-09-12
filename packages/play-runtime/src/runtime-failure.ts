import type { VagCarrierFailureDetail } from '@forgeax/editor-core/protocol';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

/** Preserve an actionable renderer cause across the iframe failure boundary. */
export function runtimeFailure(error: unknown, at = new Date().toISOString()): VagCarrierFailureDetail {
  const outer = record(error);
  let detail = outer;
  const seen = new Set<unknown>();
  while (detail && !seen.has(detail) && seen.size < 16) {
    seen.add(detail);
    if (detail.code !== 'device-operation-failed' && detail.code !== 'frame-input-invalid') break;
    const cause = record(record(detail.detail)?.cause) ?? record(detail.cause);
    if (!cause || typeof cause.code !== 'string') break;
    detail = cause;
  }
  const code = typeof detail?.code === 'string' ? detail.code : 'renderer-error';
  const hint = typeof detail?.hint === 'string' ? detail.hint
    : typeof detail?.message === 'string' ? detail.message
      : 'Inspect the renderer error before trying Play again.';
  const message = [
    typeof outer?.message === 'string' ? outer.message : undefined,
    detail !== outer ? `Cause: ${code}. ${hint}` : hint,
  ].filter(Boolean).join('\n');
  return {
    code, hint, message, at,
    stage: code === 'device-lost' ? 'device-lost' : 'uncaptured-error',
    retryable: code !== 'device-lost' && code !== 'render-system-no-camera',
  };
}
