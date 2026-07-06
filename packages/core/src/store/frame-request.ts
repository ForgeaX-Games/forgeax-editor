// store/frame-request — the "center the viewport on the primary selection" pulse.
//
// State: `frameListeners` (a fire-only signal, no value). Consumer: the
// editor-runtime forgeax camera (engine/sync.ts) via requestFrame.
//
// Anchors:
//   plan-strategy §2 D-2: cluster 4 (store.ts:149-156)
//   requirements AC-09 / plan-strategy §2 D-7: onFrameRequest is a zero-consumer
//     dead export (†) kept verbatim, `export` included — not removed, not
//     advertised as cleanup.

// Frame-request signal: "center the viewport on the primary selection" pulse.
// In editor-runtime the forgeax camera consumes this (engine/sync.ts).
const frameListeners = new Set<() => void>();
export function requestFrame(): void {
  for (const fn of frameListeners) fn();
}
export function onFrameRequest(fn: () => void): () => void {
  frameListeners.add(fn);
  return () => frameListeners.delete(fn);
}
