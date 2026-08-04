// viewport-cursor — browser cursor capture boundary for editor navigation.
// @forgeax/editor-edit-runtime — pointer lock first, pointer capture fallback.
//
// The editor viewport owns the gesture, but the host owns browser/WebView
// capability differences. The optional restorePointer hook is intentionally
// injected: ordinary browsers restore the pointer after pointer lock, while a
// host with native cursor APIs can restore the anchor after capture fallback.

import { pointerMovementDelta } from './viewport-navigation';

export type CursorCaptureMode = 'none' | 'pointer-lock' | 'pointer-capture';

export interface CursorAnchor {
  readonly x: number;
  readonly y: number;
}
export interface ViewportCursorCapture {
  begin(pointerId: number, anchor: CursorAnchor): void;
  end(): void;
  cancel(): void;
  movement(
    event: { readonly clientX: number; readonly clientY: number; readonly movementX?: number; readonly movementY?: number },
    previous: readonly [number, number],
  ): [number, number];
  isActive(): boolean;
  isPointerLocked(): boolean;
  dispose(): void;
}

export interface ViewportCursorCaptureOptions {
  readonly document?: Document;
  readonly restorePointer?: (anchor: CursorAnchor) => void;
  readonly onLost?: () => void;
}

function defaultDocument(): Document | undefined {
  return typeof globalThis.document === 'object' ? globalThis.document : undefined;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { then?: unknown }).then === 'function';
}

/**
 * Create the browser-side capture adapter.
 *
 * Pointer lock is requested only from `begin`, which is called synchronously
 * by pointerdown and therefore remains inside the browser's user-activation
 * boundary. If it is unavailable or rejected, pointer capture still keeps the
 * gesture on the canvas and movement falls back to client deltas.
 */
export function createViewportCursorCapture(
  canvas: HTMLCanvasElement,
  options: ViewportCursorCaptureOptions = {},
): ViewportCursorCapture {
  const doc = options.document ?? defaultDocument();
  let active = false;
  let ending = false;
  let mode: CursorCaptureMode = 'none';
  let pointerId: number | null = null;
  let anchor: CursorAnchor | null = null;
  let previousCursor = '';
  let cursorWasCaptured = false;
  let lockFallbackTimer: ReturnType<typeof setTimeout> | null = null;

  const clearLockFallbackTimer = (): void => {
    if (lockFallbackTimer !== null) {
      clearTimeout(lockFallbackTimer);
      lockFallbackTimer = null;
    }
  };

  const setCursorHidden = (hidden: boolean): void => {
    if (!canvas.style) return;
    if (hidden) {
      if (!cursorWasCaptured) {
        previousCursor = canvas.style.cursor;
        cursorWasCaptured = true;
      }
      canvas.style.cursor = 'none';
    } else if (cursorWasCaptured) {
      canvas.style.cursor = previousCursor;
      cursorWasCaptured = false;
    }
  };

  const capturePointer = (): void => {
    if (pointerId === null || typeof canvas.setPointerCapture !== 'function') {
      mode = 'none';
      return;
    }
    try {
      canvas.setPointerCapture(pointerId);
      mode = 'pointer-capture';
    } catch {
      // A pointer can be cancelled between pointerdown and this call. The
      // gesture remains logically active; client deltas still work when the
      // host continues delivering events.
      mode = 'none';
    }
  };

  const onPointerLockChange = (): void => {
    if (!active || ending) return;
    if (doc?.pointerLockElement === canvas) {
      mode = 'pointer-lock';
      clearLockFallbackTimer();
      return;
    }
    if (mode === 'pointer-lock') {
      mode = 'none';
      options.onLost?.();
    }
  };

  const onPointerLockError = (): void => {
    if (!active || ending) return;
    clearLockFallbackTimer();
    capturePointer();
  };

  doc?.addEventListener('pointerlockchange', onPointerLockChange);
  doc?.addEventListener('pointerlockerror', onPointerLockError);

  const requestPointerLock = (): void => {
    const request = canvas.requestPointerLock;
    if (typeof request !== 'function') {
      capturePointer();
      return;
    }
    try {
      const result = request.call(canvas);
      if (isThenable(result)) {
        void result.catch(() => {
          clearLockFallbackTimer();
          if (active && !ending) capturePointer();
        });
      }
      // Some WebViews expose requestPointerLock but do not emit
      // pointerlockerror when permission is denied. A short fallback keeps
      // navigation usable without waiting for a browser-specific event.
      lockFallbackTimer = setTimeout(() => {
        lockFallbackTimer = null;
        if (active && !ending && doc?.pointerLockElement !== canvas && mode === 'none') {
          capturePointer();
        }
      }, 250);
    } catch {
      capturePointer();
    }
  };

  const releasePointer = (): void => {
    if (pointerId !== null && typeof canvas.releasePointerCapture === 'function') {
      try {
        if (canvas.hasPointerCapture?.(pointerId)) canvas.releasePointerCapture(pointerId);
      } catch {
        // Release is best effort during teardown or pointer cancellation.
      }
    }
    if (doc?.pointerLockElement === canvas && typeof doc.exitPointerLock === 'function') {
      try {
        doc.exitPointerLock();
      } catch {
        // Browsers may reject exit during a renderer teardown; cleanup below
        // still restores the editor cursor state.
      }
    }
  };

  const finish = (): void => {
    if (!active && !cursorWasCaptured) return;
    ending = true;
    const savedAnchor = anchor;
    clearLockFallbackTimer();
    releasePointer();
    active = false;
    mode = 'none';
    pointerId = null;
    anchor = null;
    setCursorHidden(false);
    ending = false;
    if (savedAnchor) options.restorePointer?.(savedAnchor);
  };

  return {
    begin(nextPointerId, nextAnchor) {
      finish();
      active = true;
      pointerId = nextPointerId;
      anchor = { x: nextAnchor.x, y: nextAnchor.y };
      setCursorHidden(true);
      requestPointerLock();
    },
    end: finish,
    cancel: finish,
    movement(event, previous) {
      return pointerMovementDelta(event, previous, this.isPointerLocked());
    },
    isActive: () => active,
    isPointerLocked: () => mode === 'pointer-lock' || doc?.pointerLockElement === canvas,
    dispose() {
      finish();
      doc?.removeEventListener('pointerlockchange', onPointerLockChange);
      doc?.removeEventListener('pointerlockerror', onPointerLockError);
    },
  };
}
