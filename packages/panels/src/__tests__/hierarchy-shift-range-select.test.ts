// Hierarchy Shift+range selection unit test
//
// Verifies the flatVisibleOrder + handleShiftClick logic that powers
// Shift+click range selection and Ctrl+click individual toggle in the
// Hierarchy panel. Tests the pure computation (no React rendering).

import { describe, it, expect, beforeEach } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import {
  EditGateway,
  createEditSession,
  childrenOf,
  getSelection,
  getSelectionList,
  deleteManyCascade,
  gateway,
} from '@forgeax/editor-core';
import type { EditorOp, EditSession, EntityId } from '@forgeax/editor-core';

function createSession(): EditSession {
  const session = createEditSession();
  session.world = new World();
  return session;
}

// Mirror of the Hierarchy panel's flatVisibleOrder — walks the tree in
// display order, skipping collapsed subtrees.
function flatVisibleOrder(
  doc: unknown,
  collapsed: Set<EntityId>,
): EntityId[] {
  const result: EntityId[] = [];
  function walk(parentId: EntityId | null): void {
    for (const id of childrenOf(doc as any, parentId)) {
      result.push(id);
      if (!collapsed.has(id)) walk(id);
    }
  }
  walk(null);
  return result;
}

// Simulates the Shift+click range selection logic from Hierarchy.tsx
function simulateShiftClick(
  gw: EditGateway,
  doc: unknown,
  clickedId: EntityId,
  anchorId: EntityId | null,
  collapsed: Set<EntityId>,
): { newAnchor: EntityId | null } {
  const anchor = anchorId ?? getSelection();
  if (anchor === null) {
    gw.dispatch({ kind: 'setSelection', id: clickedId } as EditorOp);
    return { newAnchor: clickedId };
  }
  const order = flatVisibleOrder(doc, collapsed);
  const ai = order.indexOf(anchor);
  const ci = order.indexOf(clickedId);
  if (ai < 0 || ci < 0) {
    gw.dispatch({ kind: 'setSelection', id: clickedId } as EditorOp);
    return { newAnchor: clickedId };
  }
  const lo = Math.min(ai, ci);
  const hi = Math.max(ai, ci);
  const range = order.slice(lo, hi + 1);
  gw.dispatch({ kind: 'setSelectionMany', ids: range } as EditorOp);
  return { newAnchor: anchorId };
}

describe('Hierarchy Shift+range selection', () => {
  let gw: EditGateway;

  beforeEach(() => {
    gw = new EditGateway(createSession());
    gw.dispatch({ kind: 'setSelectionMany', ids: [] } as EditorOp);
  });

  it('Ctrl+click toggles individual nodes', () => {
    gw.dispatch({ kind: 'setSelection', id: 1 } as EditorOp);
    expect(getSelectionList()).toEqual([1]);

    gw.dispatch({ kind: 'toggleSelection', id: 3 } as EditorOp);
    expect(getSelectionList()).toEqual([1, 3]);

    gw.dispatch({ kind: 'toggleSelection', id: 1 } as EditorOp);
    expect(getSelectionList()).toEqual([3]);
  });

  it('setSelectionMany replaces the entire selection', () => {
    gw.dispatch({ kind: 'setSelection', id: 1 } as EditorOp);
    gw.dispatch({ kind: 'setSelectionMany', ids: [2, 3, 4] } as EditorOp);
    expect(getSelectionList()).toEqual([2, 3, 4]);
    expect(getSelection()).toBe(4);
  });

  it('Shift+click with no anchor falls back to single select', () => {
    const result = simulateShiftClick(gw, gw.doc, 5, null, new Set());
    expect(result.newAnchor).toBe(5);
    expect(getSelectionList()).toEqual([5]);
  });

  it('Shift+click always produces continuous range', () => {
    for (let i = 0; i < 5; i++) {
      gw.dispatch({
        kind: 'spawnEntity',
        name: `E${i}`,
        parent: null,
        components: {},
      } as EditorOp);
    }

    const ids = childrenOf(gw.doc, null);
    expect(ids.length).toBe(5);

    const anchor = ids[1]!;
    gw.dispatch({ kind: 'setSelection', id: anchor } as EditorOp);

    simulateShiftClick(gw, gw.doc, ids[3]!, anchor, new Set());
    expect(getSelectionList()).toEqual([ids[1]!, ids[2]!, ids[3]!]);
  });

  it('Shift+click upward selects range in reverse direction', () => {
    for (let i = 0; i < 5; i++) {
      gw.dispatch({
        kind: 'spawnEntity',
        name: `E${i}`,
        parent: null,
        components: {},
      } as EditorOp);
    }

    const ids = childrenOf(gw.doc, null);
    const anchor = ids[3]!;
    gw.dispatch({ kind: 'setSelection', id: anchor } as EditorOp);

    simulateShiftClick(gw, gw.doc, ids[0]!, anchor, new Set());
    expect(getSelectionList()).toEqual([ids[0]!, ids[1]!, ids[2]!, ids[3]!]);
  });

  it('collapsed subtrees are skipped in flat order', () => {
    gw.dispatch({ kind: 'spawnEntity', name: 'Root', parent: null, components: {} } as EditorOp);
    const rootId = childrenOf(gw.doc, null)[0]!;

    gw.dispatch({ kind: 'spawnEntity', name: 'Child1', parent: rootId, components: {} } as EditorOp);
    gw.dispatch({ kind: 'spawnEntity', name: 'Child2', parent: rootId, components: {} } as EditorOp);
    gw.dispatch({ kind: 'spawnEntity', name: 'Root2', parent: null, components: {} } as EditorOp);

    const roots = childrenOf(gw.doc, null);
    const kids = childrenOf(gw.doc, rootId);
    expect(roots.length).toBe(2);
    expect(kids.length).toBe(2);

    const orderOpen = flatVisibleOrder(gw.doc, new Set());
    expect(orderOpen).toEqual([rootId, kids[0]!, kids[1]!, roots[1]!]);

    const orderCollapsed = flatVisibleOrder(gw.doc, new Set([rootId]));
    expect(orderCollapsed).toEqual([rootId, roots[1]!]);
  });
});

describe('Hierarchy multi-select batch operations', () => {
  beforeEach(() => {
    gateway.replaceDoc(createSession());
    gateway.dispatch({ kind: 'setSelectionMany', ids: [] } as EditorOp);
  });

  it('deleteManyCascade removes all selected entities', () => {
    for (let i = 0; i < 4; i++) {
      gateway.dispatch({ kind: 'spawnEntity', name: `E${i}`, parent: null, components: {} } as EditorOp);
    }
    const ids = childrenOf(gateway.doc, null);
    expect(ids.length).toBe(4);

    const toDelete = [ids[1]!, ids[2]!];
    gateway.dispatch({ kind: 'setSelectionMany', ids: toDelete } as EditorOp);
    deleteManyCascade(toDelete);

    const remaining = childrenOf(gateway.doc, null);
    expect(remaining.length).toBe(2);
    expect(remaining).toEqual([ids[0]!, ids[3]!]);
    expect(getSelection()).toBeNull();
  });

  it('deleteManyCascade with snapshot preserves correct targets', () => {
    for (let i = 0; i < 3; i++) {
      gateway.dispatch({ kind: 'spawnEntity', name: `E${i}`, parent: null, components: {} } as EditorOp);
    }
    const ids = childrenOf(gateway.doc, null);
    const snapshot = [...ids];

    gateway.dispatch({ kind: 'setSelectionMany', ids: [] } as EditorOp);
    deleteManyCascade(snapshot);

    expect(childrenOf(gateway.doc, null).length).toBe(0);
  });

  it('visibility sync: setHidden dispatches successfully on multiple entities', () => {
    for (let i = 0; i < 3; i++) {
      gateway.dispatch({ kind: 'spawnEntity', name: `E${i}`, parent: null, components: {} } as EditorOp);
    }
    const ids = childrenOf(gateway.doc, null);
    expect(ids.length).toBe(3);

    const r1 = gateway.dispatch({ kind: 'setHidden', entity: ids[0]!, hidden: true } as EditorOp);
    const r2 = gateway.dispatch({ kind: 'setHidden', entity: ids[1]!, hidden: true } as EditorOp);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    const r3 = gateway.dispatch({ kind: 'setHidden', entity: ids[0]!, hidden: false } as EditorOp);
    const r4 = gateway.dispatch({ kind: 'setHidden', entity: ids[1]!, hidden: false } as EditorOp);
    expect(r3.ok).toBe(true);
    expect(r4.ok).toBe(true);

    const rNoop = gateway.dispatch({ kind: 'setHidden', entity: ids[2]!, hidden: false } as EditorOp);
    expect(rNoop.ok).toBe(true);
  });
});
