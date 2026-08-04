// hierarchy-ancestor-hidden.test.ts — UE-parity recursive hide projection
// (docs 2026-08-04-editor-hide-ue-parity-plan M3)
//
// Locks the Hierarchy structure projection's `ancestorHidden` derivation: a row
// must know when a STRICT ANCESTOR carries EditorHidden so the panel can dim it
// (lighter than own-hidden) without walking ChildOf per row per render. Uses the
// selector's DEFAULT reader against a real World — the same read path the panel
// mounts at runtime.

import { describe, it, expect, beforeEach } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import {
  EditGateway,
  createEditSession,
  createRuntimeUiGraph,
} from '@forgeax/editor-core';
import type { EditorOp, EditSession, EntityHandle } from '@forgeax/editor-core';
import { createHierarchyStructureSelector, type HierarchyEntitySummary } from '../hierarchy-state';

function createSession(): EditSession {
  const session = createEditSession();
  session.world = new World();
  return session;
}

function spawn(gw: EditGateway, name: string, parent?: EntityHandle): EntityHandle {
  const cmd: EditorOp = {
    kind: 'spawnEntity',
    name,
    ...(parent !== undefined ? { parent } : {}),
    components: { Transform: { pos: [0, 0, 0] } },
  };
  const r = gw.dispatch(cmd);
  if (!r.ok) throw new Error('spawn failed');
  return (cmd as unknown as { _id: number })._id as EntityHandle;
}

function rowOf(rows: readonly HierarchyEntitySummary[], id: EntityHandle): HierarchyEntitySummary {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`row ${id} missing from projection`);
  return row;
}

describe('Hierarchy projection — ancestorHidden (UE recursive hide)', () => {
  let gw: EditGateway;

  beforeEach(() => {
    gw = new EditGateway(createSession());
  });

  function project() {
    const graph = createRuntimeUiGraph();
    graph.bindWorld(gw.activeWorld);
    const selector = createHierarchyStructureSelector(graph);
    const mounted = selector.mount();
    graph.publish();
    const snapshot = mounted.getSnapshot();
    mounted.unsubscribe();
    if (!snapshot) throw new Error('no projection snapshot');
    return snapshot.rows;
  }

  it('hidden parent marks every descendant ancestorHidden, sibling untouched', () => {
    const parent = spawn(gw, 'Parent');
    const child = spawn(gw, 'Child', parent);
    const grandchild = spawn(gw, 'Grandchild', child);
    const sibling = spawn(gw, 'Sibling');
    gw.dispatch({ kind: 'setHidden', entity: parent, hidden: true } as EditorOp);

    const rows = project();
    expect(rowOf(rows, parent).hidden).toBe(true);
    expect(rowOf(rows, parent).ancestorHidden).toBe(false);
    expect(rowOf(rows, child).hidden).toBe(false);
    expect(rowOf(rows, child).ancestorHidden).toBe(true);
    expect(rowOf(rows, grandchild).hidden).toBe(false);
    expect(rowOf(rows, grandchild).ancestorHidden).toBe(true);
    expect(rowOf(rows, sibling).hidden).toBe(false);
    expect(rowOf(rows, sibling).ancestorHidden).toBe(false);
  });

  it('unhiding the parent restores descendant rows to fully visible', () => {
    const parent = spawn(gw, 'Parent');
    const child = spawn(gw, 'Child', parent);
    gw.dispatch({ kind: 'setHidden', entity: parent, hidden: true } as EditorOp);
    gw.dispatch({ kind: 'setHidden', entity: parent, hidden: false } as EditorOp);

    const rows = project();
    expect(rowOf(rows, parent).ancestorHidden).toBe(false);
    expect(rowOf(rows, child).hidden).toBe(false);
    expect(rowOf(rows, child).ancestorHidden).toBe(false);
  });

  it('a hidden child under a hidden parent keeps its own flag after the parent shows', () => {
    const parent = spawn(gw, 'Parent');
    const child = spawn(gw, 'Child', parent);
    gw.dispatch({ kind: 'setHidden', entity: child, hidden: true } as EditorOp);
    gw.dispatch({ kind: 'setHidden', entity: parent, hidden: true } as EditorOp);
    gw.dispatch({ kind: 'setHidden', entity: parent, hidden: false } as EditorOp);

    const rows = project();
    expect(rowOf(rows, child).hidden).toBe(true);
    expect(rowOf(rows, child).ancestorHidden).toBe(false);
  });
});
