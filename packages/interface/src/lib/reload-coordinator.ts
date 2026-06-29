/**
 * Reload coordinator — serializes engine-iframe cold reloads.
 *
 * Why: when the active game slug changes, the viewport surface, every editor
 * sub-panel iframe (`/editor/?panel=X`), and keep-alive plugin iframes all want
 * to reload in the SAME frame. Each reloading engine iframe spins up its own
 * WebGPU device; doing N of them at once overruns WKWebView's context budget and
 * the whole stack goes black (see performance-analysis-2 §维度3 / #3).
 *
 * This is a host-shell concern (the engine can't know how many siblings are
 * rebuilding), so the fix lives here: callers acquire a reload "slot" and the
 * coordinator grants them one at a time, spaced by a short gap, so only one new
 * WebGPU context comes up per tick instead of a thundering herd.
 *
 * It intentionally does NOT rebuild the engine device or touch engine-internal
 * state — that would be out-of-engine reimplementation. It only orders WHEN the
 * host lets each iframe begin its own reload.
 */

/** Minimum gap between successive reload grants (ms). One WebGPU context comes
 *  up per gap; tuned to stay comfortably under WKWebView's concurrent-context
 *  ceiling while keeping a full game switch snappy. */
const GRANT_GAP_MS = 250;

type Waiter = { run: () => void };

const queue: Waiter[] = [];
let draining = false;
let lastGrantAt = 0;

function drain(): void {
  if (draining) return;
  draining = true;
  const step = (): void => {
    const next = queue.shift();
    if (!next) {
      draining = false;
      return;
    }
    const now = Date.now();
    const wait = Math.max(0, GRANT_GAP_MS - (now - lastGrantAt));
    window.setTimeout(() => {
      lastGrantAt = Date.now();
      try {
        next.run();
      } catch {
        /* a single iframe's reload throwing must not stall the queue */
      }
      step();
    }, wait);
  };
  step();
}

/**
 * Request a serialized reload slot. `run` is invoked when it's this caller's
 * turn (one at a time, spaced by GRANT_GAP_MS). Returns a cancel fn that
 * de-queues the request if it hasn't run yet (e.g. the component unmounted or
 * the slug changed again before its turn).
 */
export function requestReloadSlot(run: () => void): () => void {
  const waiter: Waiter = { run };
  queue.push(waiter);
  drain();
  return () => {
    const i = queue.indexOf(waiter);
    if (i >= 0) queue.splice(i, 1);
  };
}
