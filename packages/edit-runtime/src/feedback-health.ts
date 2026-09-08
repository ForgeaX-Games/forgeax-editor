export type FeedbackHealthSource = 'edit' | 'play';

export interface FeedbackHealthSignal {
  readonly code: string;
  readonly message: string;
  readonly source: FeedbackHealthSource;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.stack || error.message || fallback;
  const detail = record(error);
  const message = typeof detail?.message === 'string'
    ? detail.message
    : typeof detail?.hint === 'string'
      ? detail.hint
      : fallback;
  const stack = typeof detail?.stack === 'string' ? detail.stack : undefined;
  return stack && !message.includes(stack) ? `${message}\n${stack}` : message;
}

export function errorCode(error: unknown, fallback: string): string {
  const code = record(error)?.code;
  return typeof code === 'string' && code.trim() !== '' ? code : fallback;
}

export function forwardFeedbackHealth(signal: FeedbackHealthSignal): void {
  try {
    window.parent?.postMessage({
      type: 'forgeax:health',
      level: 'error',
      source: signal.source,
      code: signal.code,
      message: signal.message,
    }, '*');
  } catch {
    // The health channel is best effort and must not mask the owning failure.
  }
}

export function normalizeSaveFailureCode(error: unknown): string {
  const code = errorCode(error, 'write-failed').toLowerCase();
  if (code.includes('serial')) return 'save-serialization-failed';
  if (code.includes('pack') || code.includes('valid')) return 'save-pack-validation-failed';
  return 'save-write-failed';
}

export function normalizePlayFailureCode(error: unknown): string {
  const code = errorCode(error, 'assemble-failed').toLowerCase();
  if (code.includes('save')) return 'play-save-failed';
  if (code.includes('boot') || code.includes('carrier')) return 'play-bootstrap-failed';
  // A render-loop fault surfaces through the same Play lifecycle callback, but
  // requirements §4 classifies by the blocked work surface: the session DID start
  // and then its rendering died, which is 渲染进程异常终止 — not "Play 无法启动".
  // Verified against a real ECS update throw reported as `app-system-update-failed`.
  if (code === 'app-system-update-failed' || /^renderer-/.test(code)) {
    return normalizeRendererFailureCode(error);
  }
  return 'play-assemble-failed';
}

const EXPECTED_PLAY_REFUSALS = new Set([
  'play-cancelled-dirty',
  'preview-rejected-dirty',
  'render-system-no-camera',
]);

export function isReportablePlayFailure(error: unknown): boolean {
  return !EXPECTED_PLAY_REFUSALS.has(errorCode(error, '').toLowerCase());
}

export function normalizeRendererFailureCode(error: unknown): string {
  const code = errorCode(error, 'renderer-error').toLowerCase();
  if (code === 'device-lost' || code === 'context-lost') return code;
  if (code.includes('webgpu') || code === 'rhi-not-available' || code === 'engine-environment-error') {
    return 'webgpu-init-failed';
  }
  return /^renderer-/.test(code) ? code : 'renderer-error';
}

/** Normalize a Play carrier terminal failure into a classifier-known code.
 *
 *  The carrier's own error union is much wider than the requirements' nine
 *  incident families (`play-carrier-ready-timeout`, `play-carrier-stopped`,
 *  `play-carrier-capture-*`, …). Forwarding `failure.code` verbatim let 13 of 19
 *  reachable codes escape the classifier, so no card ever appeared for them.
 *
 *  Placement follows requirements §4 "按被挡的工作面归类,不按技术模块", and §4.2
 *  which lists `VAG_CARRIER_FAILURE` under 视口运行时断开:
 *    - could never reach a running Play  → play-bootstrap-failed (Play 无法启动)
 *    - was running and then died//stalled → viewport-runtime-disconnected
 *  Every branch ends in a known family; this function must stay total.
 */
export function normalizeCarrierFailureCode(failure: unknown): string {
  const code = errorCode(failure, 'renderer-error').toLowerCase();
  const stage = (() => {
    const value = record(failure)?.stage;
    return typeof value === 'string' ? value.toLowerCase() : '';
  })();

  if (code === 'device-lost' || code === 'context-lost') return code;
  if (code.includes('webgpu')) return 'webgpu-init-failed';
  if (code === 'renderer-process-terminated' || code === 'viewport-runtime-disconnected') return code;
  if (stage === 'heartbeat') return 'viewport-runtime-disconnected';

  // Startup/handshake never produced a usable Play surface → "Play 无法启动".
  if (stage === 'handshake' || code === 'play-carrier-ready-timeout'
    || code === 'play-carrier-window-unavailable' || code === 'play-carrier-not-active'
    || code === 'play-carrier-transition-active') {
    return 'play-bootstrap-failed';
  }
  // A carrier that was live and then stopped/lost its channel is the runtime
  // dropping out from under a running Play, not a failed launch.
  if (code === 'play-carrier-stopped' || code.startsWith('play-gameplay-request-')) {
    return 'viewport-runtime-disconnected';
  }
  // Capture/provenance faults happen against a live carrier whose rendering is
  // no longer trustworthy.
  if (code.startsWith('play-carrier-capture-') || code === 'play-carrier-provenance-unavailable') {
    return 'renderer-error';
  }
  if (code.startsWith('play-')) return 'play-bootstrap-failed';
  if (/^renderer-/.test(code)) return code;
  return 'renderer-error';
}

