// store/frame-request — the "center the viewport on the primary selection" pulse.
//
// State: `frameListeners` (a fire-only signal, no value). Consumer: the
// editor-runtime forgeax camera (engine/sync.ts) via requestFrame.
//
// Anchors:
//   plan-strategy §2 D-2: cluster 4 (store.ts:149-156)
//   plan-strategy §2 D-1/D-10: requestFrame is a SESSION-domain op — the body is
//     the applier, registered into sessionAppliers; the setter dispatches (M2
//     m2-w7). onFrameRequest was a ZERO-CONSUMER dead export (research F2) and is
//     DELETED on collection per D-10 (verified: only re-export sites, no runtime
//     subscriber). frameListeners is kept so the applier's fire path stays
//     structurally identical (a future subscriber re-adds an accessor).
//   requirements AC-02: session op, AI-dispatchable, ledger only.
import type { EditorOp } from '../types';
import { sessionAppliers } from '../io/appliers';

// Frame-request signal: "center the viewport on the primary selection" pulse.
const frameListeners = new Set<() => void>();

// Session applier (M2 D-1/D-10): fire-only pulse, no value, no inverse.
function applyRequestFrame(_op: EditorOp): { ok: true } {
  for (const fn of frameListeners) fn();
  return { ok: true };
}
sessionAppliers.set('requestFrame', applyRequestFrame);

// M3 t22 (S10 / AC-21/22): requestFrame write-side sugar deleted — callers
// dispatch gateway.dispatch({ kind: 'requestFrame' }) directly.
