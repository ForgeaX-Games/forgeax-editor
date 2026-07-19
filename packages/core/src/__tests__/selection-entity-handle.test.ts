// w15 — TDD red-phase: selection migrated to Set<EntityHandle>
//
// feat-20260707-editor-world-fork-ssot-level-load-play-activeworld M3 (I1 / AC-10):
// Selection state moves from EntityId[] to Set<EntityHandle>. The runtime
// identity is the engine handle (no legacy id), so the selection store holds
// live handles. Semantics preserved:
//   (a) getSelectionList() returns a Set<EntityHandle>;
//   (b) the LAST added element is the primary (getSelection() returns it);
//   (c) setSelection/toggleSelection/setSelectionMany appliers operate on handles;
//   (d) isSelected(handle) reflects membership;
//   (e) clearSelection() empties the Set (the enterPlay/exitPlay lifecycle seam,
//       D-11 — handles from a previous world are invalid after a world switch).
//
// This test is RED until w20 rewrites selection.ts.
//
// Constraints from upstream:
//   requirements AC-10: selection is Set<EntityHandle>, all consumers migrated,
//     play/stop each clear selection
//   plan-strategy D-11: enterPlay/exitPlay clear the selection store directly
//   research Finding 6: post trace-ioc t22 selection.ts is applier + read side only
//
// Anchors:
//   plan-tasks.json w15

import { describe, expect, it, beforeEach } from 'bun:test';
import type { EntityHandle } from '../scene/scene-types';
import {
  getSelection,
  getSelectionList,
  isSelected,
  clearSelection,
} from '../store/selection';
import { sessionAppliers } from '../io/appliers';

function h(n: number): EntityHandle {
  return n as EntityHandle;
}

function applySel(kind: string, payload: Record<string, unknown>): void {
  const applier = sessionAppliers.get(kind);
  if (!applier) throw new Error(`no applier for ${kind}`);
  const r = applier({ kind, ...payload } as never, undefined as never);
  if (!r.ok) throw new Error(`applier ${kind} failed`);
}

describe('w15 — selection Set<EntityHandle>', () => {
  beforeEach(() => {
    clearSelection();
  });

  // ── (a) getSelectionList returns a Set<EntityHandle> ─────────────────────
  it('(a) getSelectionList() returns a Set (not an array)', () => {
    const list = getSelectionList();
    expect(list instanceof Set).toBe(true);
  });

  // ── (b) LAST added element is primary ────────────────────────────────────
  it('(b) getSelection() returns the last added handle (primary)', () => {
    applySel('setSelectionMany', { ids: [h(10), h(20), h(30)] });
    expect(getSelection()).toBe(h(30));
    const list = getSelectionList();
    expect(list.has(h(10))).toBe(true);
    expect(list.has(h(20))).toBe(true);
    expect(list.has(h(30))).toBe(true);
    expect(list.size).toBe(3);
  });

  it('(b) setSelection(null) clears; setSelection(handle) selects one', () => {
    applySel('setSelection', { id: h(42) });
    expect(getSelection()).toBe(h(42));
    expect(getSelectionList().size).toBe(1);
    applySel('setSelection', { id: null });
    expect(getSelection()).toBeNull();
    expect(getSelectionList().size).toBe(0);
  });

  // ── (c/d) toggleSelection + isSelected on handles ────────────────────────
  it('(c/d) toggleSelection adds then removes a handle; isSelected reflects it', () => {
    applySel('toggleSelection', { id: h(7) });
    expect(isSelected(h(7))).toBe(true);
    expect(getSelection()).toBe(h(7));
    applySel('toggleSelection', { id: h(7) });
    expect(isSelected(h(7))).toBe(false);
    expect(getSelection()).toBeNull();
  });

  it('(c) toggle preserves LAST-added primary semantics', () => {
    applySel('toggleSelection', { id: h(1) });
    applySel('toggleSelection', { id: h(2) });
    expect(getSelection()).toBe(h(2));
    // removing the primary falls back to the remaining member
    applySel('toggleSelection', { id: h(2) });
    expect(getSelection()).toBe(h(1));
  });

  // ── (e) clearSelection empties (D-11 lifecycle seam) ─────────────────────
  it('(e) clearSelection() empties the Set (play/stop lifecycle seam)', () => {
    applySel('setSelectionMany', { ids: [h(3), h(4)] });
    expect(getSelectionList().size).toBe(2);
    clearSelection();
    expect(getSelectionList().size).toBe(0);
    expect(getSelection()).toBeNull();
  });
});
