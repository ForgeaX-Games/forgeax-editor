// io/trace — module-level span stack + ring-buffer root-tree retention
//
// feat-20260707-editor-trace-ioc M2 t9/t11:
// Module-level pushSpan/popSpan stack (NOT AsyncLocalStorage — F-2 verified
// that dispatch/applyCommand is a pure synchronous chain). Span fields align
// with OTel (traceId 32-hex / spanId 16-hex / parentSpanId / name / start /
// end / attributes / status). Ring buffer retains the last 256 root span
// trees; eviction increments droppedTraces (Plan D-3 Q-4).
//
// ASYNC SESSION OP DISCLAIMER (research F-2):
// 4 async session ops (saveDocToDisk / loadDocFromDisk / switchSceneFile /
// createSceneFile) use fire-and-forget runAsyncOp — the applier returns
// synchronously while the real disk I/O continues in a detached promise.
// The span covers ONLY the synchronous applier body; the detached
// continuation is NOT inside any span interval. This is consistent with
// OOS-1 (no side-effect causality tracking) and is declared here + in the
// skill boundary section.
//
// Anchors:
//   plan-strategy §2 D-3: module-level stack + OTel fields + ring buffer 256
//   requirements AC-07: nested dispatch → parent-child span auto-linking
//   requirements AC-08: parent start ≤ child start ≤ child end ≤ parent end
//   requirements AC-09: leaf engine interface names in span attributes
//   requirements AC-10: trace programmatically readable via gateway.trace
//   research F-2: sync chain verified — stack premise holds

// ── Random hex ID helpers (crypto-quality, OTel format) ─────────────────────

function randomHex(len: number): string {
  const arr = new Uint8Array(len / 2);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Span types (OTel-aligned, plan-strategy §2 D-3) ─────────────────────────

/** Leaf engine interface name recorded on the current active span. */
export type EngineInterfaceName =
  | 'world.set'
  | 'world.spawn'
  | 'world.despawn'
  | 'world.allocSharedRef'
  | 'world.addComponent'
  | 'world.removeComponent';

/** A single span node in the trace tree. */
export interface SpanNode {
  /** OTel traceId (32 hex chars). Shared by all spans in one root tree. */
  traceId: string;
  /** OTel spanId (16 hex chars). Unique per span. */
  spanId: string;
  /** Explicit parent spanId (16 hex chars), or null for root spans. */
  parentSpanId: string | null;
  /** Operation name (dispatch kind). */
  name: string;
  /** Monotonic start timestamp (performance.now ms). */
  start: number;
  /** End timestamp, set on popSpan. 0 = still open. */
  end: number;
  /** Leaf engine interface names recorded during this span. */
  attributes: { engineCalls: EngineInterfaceName[] };
  /** OK on normal exit, ERROR if applier returns !ok. */
  status: 'OK' | 'ERROR';
  /** Child spans produced by nested dispatchSub (recursive). */
  children: SpanNode[];
}

// ── Module-level stack (sync only — F-2 verified) ───────────────────────────

/**
 * The active span stack. The top of the stack is the currently-open span.
 * Nested dispatch/sub-dispatch pushes a child span on top; pop restores
 * the parent. Empty stack = no active span (e.g. between dispatches).
 */
const _spanStack: SpanNode[] = [];

/** Return the currently active span, or null if the stack is empty. */
export function activeSpan(): SpanNode | null {
  return _spanStack.length > 0 ? _spanStack[_spanStack.length - 1]! : null;
}

/**
 * Push a new span onto the stack. If the stack is non-empty, the new span
 * becomes a child of the current top (automatic parent-child linking, AC-07).
 * The new span's start time is captured now.
 *
 * @returns the newly created span node (mutable — the caller or applier can
 *          push engineCall entries directly onto its attributes).
 */
export function pushSpan(name: string): SpanNode {
  const parent = activeSpan();
  const traceId = parent ? parent.traceId : randomHex(32);
  const spanId = randomHex(16);
  const span: SpanNode = {
    traceId,
    spanId,
    parentSpanId: parent ? parent.spanId : null,
    name,
    start: performance.now(),
    end: 0,
    attributes: { engineCalls: [] },
    status: 'OK',
    children: [],
  };
  if (parent) {
    parent.children.push(span);
  } else {
    // Root span — push into ring buffer on pop.
  }
  _spanStack.push(span);
  return span;
}

/**
 * Pop the current span off the stack. Sets end timestamp.
 * If this is a root span (no parent on stack), inserts it into the ring buffer.
 */
export function popSpan(status: 'OK' | 'ERROR' = 'OK'): SpanNode | null {
  const span = _spanStack.pop();
  if (!span) return null;
  span.end = performance.now();
  span.status = status;
  // If this is a root span (stack is now empty, or the next item is a different
  // root's ancestor — we detect root by checking if it has no parentSpanId),
  // insert into the ring buffer.
  if (span.parentSpanId === null && _spanStack.length === 0) {
    _insertRoot(span);
  }
  return span;
}

// ── Ring buffer (plan-strategy §2 D-3: 256 root trees) ──────────────────────

const RING_CAPACITY = 256;

/** Ring buffer of completed root span trees. Oldest at index 0. */
const _rootTrees: SpanNode[] = [];

/** Count of root trees evicted from the ring buffer. Always monotonic. */
let _droppedTraces = 0;

export function droppedTracesCount(): number {
  return _droppedTraces;
}

function _insertRoot(root: SpanNode): void {
  if (_rootTrees.length >= RING_CAPACITY) {
    // Evict the oldest root tree
    _rootTrees.shift();
    _droppedTraces++;
  }
  _rootTrees.push(root);
}

// ── Public read API (gateway.trace, AC-10) ──────────────────────────────────

/** Programming read: return the most recent N root span trees. */
export function recentRoots(n: number = 1): SpanNode[] {
  const start = Math.max(0, _rootTrees.length - n);
  return _rootTrees.slice(start);
}

/** Programming read: return the most recent single root span tree. */
export function lastRoot(): SpanNode | null {
  return _rootTrees.length > 0 ? _rootTrees[_rootTrees.length - 1]! : null;
}
