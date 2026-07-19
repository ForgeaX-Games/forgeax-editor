// store/cb-nav — content-browser navigation history (session domain).
//
// State: history stack + current index. Consumers: CB package via
// useCBNav / getCBNavState / onCBNavChange from the @forgeax/editor-core barrel.
//
// Anchors:
//   plan-strategy §2 D-4: CBNavEntry is module-private (not exported); CB package
//     keeps its own definition — no core↔CB type coupling introduced.
//   plan-strategy §2 D-5: gizmo-mode.ts 43-line structural template.
//   plan-strategy §2 D-2: dedup semantics — history stack dedup vs. ledger full-record.
//   requirements §R4/R10: module-private CBNavEntry; dual-package independence.
import { useSyncExternalStore } from 'react';
import type { EditorOp } from '../types';
import { sessionAppliers } from '../io/appliers';

// plan-strategy §2 D-4: module-private — not exported. CB package retains its
// own definition (content-browser/src/types.ts). No shared core export to avoid
// a potential core↔content-browser import cycle.
type CBNavEntry = { path: string; timestamp: number };

// ── Module-level state (plan-strategy §2 D-5: gizmo-mode.ts structural template) ─
// Initial history: single root entry with path '' (requirements §C7).
// index: pointer into history; invariant: 0 <= index < history.length.
let history: CBNavEntry[] = [{ path: '', timestamp: Date.now() }];
let index = 0;

const cbNavListeners = new Set<() => void>();

// Snapshot cache: recomputed in emit() before notifying listeners.
// useSyncExternalStore requires getSnapshot to return the same reference when
// state is unchanged (Object.is comparison). Storing as module-level var ensures
// stable reference within a render cycle when history/index have not mutated.
let _snapshot = { path: history[0]!.path, canGoBack: false, canGoForward: false };

function emit(): void {
  _snapshot = {
    path: history[index]?.path ?? '',
    canGoBack: index > 0,
    canGoForward: index < history.length - 1,
  };
  cbNavListeners.forEach((fn) => fn());
}

// ── Session appliers (plan-strategy §2 D-1) ──────────────────────────────────
// These are the ONLY code that touches the history/index state.
// Not exported: mutation always goes through gateway.dispatch (requirements §C4).
//
// D-2 intentional dedup semantics:
//   gizmo-mode.ts L25: same-mode dispatch → no emit AND no ledger write.
//   setCBPath same-path dispatch → no emit BUT ledger IS written (gateway auto-appends
//   for all session ops regardless of applier return value). This difference is
//   by design (D-2) — setCBPath ledger records the navigation intent stream in full
//   (requirements §C3), even when the history stack does not grow.

function applySetCBPath(op: EditorOp): { ok: true } {
  const path = (op as { path: string }).path;
  // Dedup: same path as current — skip history push and emit; ledger still written.
  if (path === history[index]?.path) {
    return { ok: true };
  }
  // Tail-truncation: discard any forward entries beyond current index.
  history = [...history.slice(0, index + 1), { path, timestamp: Date.now() }];
  index = history.length - 1;
  emit();
  return { ok: true };
}

function applyCBGoBack(_op: EditorOp): { ok: true } {
  if (index > 0) {
    index--;
    emit();
  }
  return { ok: true };
}

function applyCBGoForward(_op: EditorOp): { ok: true } {
  if (index < history.length - 1) {
    index++;
    emit();
  }
  return { ok: true };
}

sessionAppliers.set('setCBPath', applySetCBPath);
sessionAppliers.set('cbGoBack', applyCBGoBack);
sessionAppliers.set('cbGoForward', applyCBGoForward);

// ── Read interface (requirements §R5) ────────────────────────────────────────
// Only read-only exports — no set*/toggle* functions (requirements §C4).

/** Current content-browser path (raw getter — use useCBNav in React). */
export function getCBPath(): string {
  return history[index]?.path ?? '';
}

/** Snapshot of CB nav state: current path + back/forward capability flags. */
export function getCBNavState(): { path: string; canGoBack: boolean; canGoForward: boolean } {
  return _snapshot;
}

/** Subscribe to CB nav state changes (non-React consumers, e.g. toolbar buttons). */
export function onCBNavChange(fn: () => void): () => void {
  cbNavListeners.add(fn);
  return () => cbNavListeners.delete(fn);
}

/** React hook: returns stable snapshot; re-renders only on state changes. */
export function useCBNav(): { path: string; canGoBack: boolean; canGoForward: boolean } {
  return useSyncExternalStore(onCBNavChange, getCBNavState, getCBNavState);
}
