// store/selection — the transient entity-selection set (deixis handle source).
//
// feat-20260709-editor-world-partition-editorworld-super-composite M5 (w26):
// selection now holds Set<HandlePair> — every selected entity is bound to the
// WORLD it lives in (worldRef) and the epoch of that world's binding at mint
// time. Before the world split a selection was a bare Set<EntityHandle> with no
// world identity; after the split a handle alone is ambiguous (the RD3 red line:
// the same (index, generation) can be live in both editorWorld and sceneWorld),
// so selection must carry the world-bound pair. On a scene reload the world
// binding epoch bumps and revalidateSelection() drops every now-stale pair in one
// pass — the batch invalidation AC-05 requires.
//
// Public read surface is UNCHANGED (AC-01 barrel snapshot): getSelection() still
// returns EntityHandle | null and getSelectionList() still returns
// Set<EntityHandle> — both DERIVED from the pair set (a cached Set<EntityHandle>
// kept stable across reads so useSyncExternalStore does not loop). getSelectionPair()
// is new and NOT on the barrel — it is the super (world-manager) consumer's door.
//
// The (worldRef, epoch) a new pair is minted with comes from a binding provider
// that world-manager registers at boot (registerSelectionBindingProvider — same
// DAG-legal IoC pattern as registerSessionApplier: core defines the seam, the
// DAG-downstream edit-runtime fills it). Headless core (no provider) falls back
// to the scene worldRef at epoch 0 — enough for in-package tests that never reload.
//
// feat-20260707-editor-world-fork M3 precursor: setSelection/toggleSelection/
// setSelectionMany are SESSION-domain op appliers (registered into sessionAppliers);
// enterPlay/exitPlay clear the selection store directly (D-11 lifecycle seam).
//
// Anchors:
//   requirements AC-05 (scene reload → selection batch invalidation — RED LINE)
//   requirements AC-06 / S7 (handle misuse structured; selection carries world)
//   plan-strategy §2 D-4 (selection.ts evolves to consume the handle-pair type)
//   research F4 (selection was Set<EntityHandle> with no world binding)
import { useSyncExternalStore } from 'react';
import type { EditorOp } from '../types';
import type { EntityHandle } from '../scene/scene-types';
import type { HandlePair } from './handle-pair';
import { sessionAppliers } from '../io/appliers';

// The scene worldRef used for the headless fallback (no binding provider). Mirrors
// edit-runtime WorldBinding's WORLD_REF_SCENE (the SSOT); core cannot import that
// module (DAG), so this literal is the documented headless default only — when a
// provider is registered its worldRef wins.
const HEADLESS_SCENE_WORLD_REF = 1;

// Selection is a Set of world-bound handle pairs; the LAST inserted pair is the
// "primary" (drives single-target panels like Inspector). Set preserves insertion
// order, so the primary is the last element of the iteration.
let selectionSet: Set<HandlePair> = new Set();
// Cached Set<EntityHandle> derived from selectionSet — rebuilt only when the
// selection mutates so useSyncExternalStore sees a stable reference between reads.
let derivedHandleSet: Set<EntityHandle> = new Set();
const selectionListeners = new Set<() => void>();

// ── Binding provider (IoC seam — world-manager fills it, D-4/RD4) ────────────
// Supplies the (worldRef, epoch) a NEW pair is minted with. Registered by
// edit-runtime's WorldManager.attach(); undefined in headless core.
type SelectionBinding = { worldRef: number; epoch: number };
let bindingProvider: (() => SelectionBinding | undefined) | null = null;

/** Register the selection binding provider (world-manager, at boot). Returns an
 *  unregister fn. The provider tells selection which world + epoch to stamp onto
 *  newly selected handles so a later reload can batch-invalidate them (AC-05). */
export function registerSelectionBindingProvider(
  fn: () => SelectionBinding | undefined,
): () => void {
  bindingProvider = fn;
  return () => {
    if (bindingProvider === fn) bindingProvider = null;
  };
}

/** The (worldRef, epoch) to mint a new pair with — provider value or the headless
 *  scene default. */
function currentBinding(): SelectionBinding {
  return bindingProvider?.() ?? { worldRef: HEADLESS_SCENE_WORLD_REF, epoch: 0 };
}

/** Wrap a bare handle into a world-bound pair against the current binding. */
function mint(entity: EntityHandle): HandlePair {
  const b = currentBinding();
  return { worldRef: b.worldRef, epoch: b.epoch, entity };
}

/** Rebuild the derived Set<EntityHandle> from the pair set (stable-ref cache). */
function rebuildDerived(): void {
  const next = new Set<EntityHandle>();
  for (const p of selectionSet) next.add(p.entity);
  derivedHandleSet = next;
}

// Cross-window selection sync via localStorage (works across Tauri WebviewWindow
// processes, where BroadcastChannel can't reach). Dev-only runaway-propagation
// net: if selection emits a storm within a short window it almost always means a
// cross-window echo loop regressed. Warns once per window so it's visible without
// re-instrumenting. No-op in production.
let _emitWindowStart = 0;
let _emitCount = 0;
let _emitWarned = false;
function emitSelection(): void {
  // The derived handle set is rebuilt on every mutation so the read helpers hand
  // out a stable reference until the next change (useSyncExternalStore contract).
  rebuildDerived();
  // editor-core is typechecked with plain tsc (Bun import.meta types, no
  // vite/client), so `import.meta.env` isn't on ImportMeta here — cast locally.
  // At runtime this module is Vite-bundled, where `import.meta.env.DEV` is real.
  if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
    const now = Date.now();
    if (now - _emitWindowStart > 1000) { _emitWindowStart = now; _emitCount = 0; _emitWarned = false; }
    if (++_emitCount > 32 && !_emitWarned) {
      _emitWarned = true;
      // eslint-disable-next-line no-console
      console.warn(`[sel-sync] runaway selection propagation: ${_emitCount} emits within 1s — likely a cross-window echo loop (see docs/design/editor-cross-window-selection-sync-loop.md)`);
    }
  }
  for (const fn of selectionListeners) fn();
}

/** The primary selection = the LAST inserted handle (Set preserves order). */
export function getSelection(): EntityHandle | null {
  let last: EntityHandle | null = null;
  for (const p of selectionSet) last = p.entity;
  return last;
}
/** The primary selection PAIR (world-bound) — the super (world-manager) door.
 *  NOT on the barrel; consumed by edit-runtime to validate before read/write. */
export function getSelectionPair(): HandlePair | null {
  let last: HandlePair | null = null;
  for (const p of selectionSet) last = p;
  return last;
}
/** The full selection as a Set<EntityHandle> (live reference — do not mutate;
 *  treat as read-only). Derived + cached from the pair set. */
export function getSelectionList(): Set<EntityHandle> {
  return derivedHandleSet;
}
/** The full selection as world-bound pairs — super consumer door (not on barrel). */
export function getSelectionPairs(): Set<HandlePair> {
  return selectionSet;
}
export function isSelected(handle: EntityHandle): boolean {
  return derivedHandleSet.has(handle);
}

// ── Session appliers (D-1): the mutation bodies, registered into the session
// table. These are the ONLY code that touches selectionSet; UI/AI dispatch ops
// that route here.
function applySetSelection(op: EditorOp): { ok: true } {
  const id = (op as { id: EntityHandle | null }).id;
  if (id === null) {
    if (selectionSet.size !== 0) { selectionSet = new Set(); emitSelection(); }
  } else if (!(selectionSet.size === 1 && derivedHandleSet.has(id))) {
    selectionSet = new Set([mint(id)]);
    emitSelection();
  }
  return { ok: true };
}
function applyToggleSelection(op: EditorOp): { ok: true } {
  const id = (op as unknown as { id: EntityHandle }).id;
  const next = new Set(selectionSet);
  // Find the existing pair for this handle (if any) in the current set.
  let existing: HandlePair | undefined;
  for (const p of next) if (p.entity === id) { existing = p; break; }
  if (existing) {
    next.delete(existing);
  } else {
    // Re-insert so a toggled-on handle becomes the LAST element (primary).
    next.add(mint(id));
  }
  selectionSet = next;
  emitSelection();
  return { ok: true };
}
function applySetSelectionMany(op: EditorOp): { ok: true } {
  const ids = (op as unknown as { ids: EntityHandle[] }).ids;
  selectionSet = new Set(ids.map(mint));
  emitSelection();
  return { ok: true };
}
sessionAppliers.set('setSelection', applySetSelection);
sessionAppliers.set('toggleSelection', applyToggleSelection);
sessionAppliers.set('setSelectionMany', applySetSelectionMany);

// M3 t22 (trace-ioc): the write-side sugar setters were dispatch-only zombie
// exports — deleted; callers dispatch through the one gateway door directly.
// Read-side pub/sub (getSelection / getSelectionList / onSelectionChange /
// useSelection) is orthogonal and stays. The session appliers above remain the
// mutation bodies (registered into sessionAppliers).

function subscribeSelection(fn: () => void): () => void {
  selectionListeners.add(fn);
  return () => selectionListeners.delete(fn);
}

/** Non-React selection subscription (the viewport gizmo follows the selection). */
export const onSelectionChange = subscribeSelection;

export function useSelection(): EntityHandle | null {
  return useSyncExternalStore(subscribeSelection, getSelection, getSelection);
}
export function useSelectionList(): Set<EntityHandle> {
  return useSyncExternalStore(subscribeSelection, getSelectionList, getSelectionList);
}

/**
 * Drop every selected pair that is no longer valid against the CURRENT binding
 * (world-manager calls this after a scene-reload epoch bump — D-4 / AC-05).
 *
 * Batch invalidation: a whole-world reload advances the binding epoch, so every
 * pair minted at the prior epoch fails the epoch comparison here and is removed
 * in one pass — the observable "selection cleared, no residual old-world handle"
 * outcome E1 asserts. Pairs whose worldRef differs from the current binding are
 * also dropped (defensive; a selection is always scene-world in edit mode).
 */
export function revalidateSelection(): void {
  const b = currentBinding();
  let changed = false;
  const next = new Set<HandlePair>();
  for (const p of selectionSet) {
    if (p.worldRef === b.worldRef && p.epoch === b.epoch) {
      next.add(p);
    } else {
      changed = true;
    }
  }
  if (changed) {
    selectionSet = next;
    emitSelection();
  }
}

/**
 * Directly clear selection — lifecycle seam for enterPlay/exitPlay (D-11).
 *
 * Not an edit op, not dispatched, not recorded in ledger/undo. enterPlay/exitPlay
 * call this directly because selection clearing is lifecycle semantics, not an
 * edit action — the selection store is transient view state and handles from a
 * previous world are invalid after a world switch.
 */
export function clearSelection(): void {
  if (selectionSet.size !== 0) {
    selectionSet = new Set();
    emitSelection();
  }
}
