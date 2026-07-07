import { describe, it, expect, beforeEach } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import {
  createEditSession,
  gateway,
  entName,
  childrenOf,
  getSelection,
} from '@forgeax/editor-core';
import type { EditorOp, EditSession } from '@forgeax/editor-core';

function createSession(): EditSession {
  const session = createEditSession();
  session.world = new World();
  return session;
}

describe('Inspector name sync after Hierarchy rename', () => {
  beforeEach(() => {
    gateway.replaceDoc(createSession());
  });

  it('entName reflects new name immediately after rename dispatch', () => {
    gateway.dispatch({ kind: 'spawnEntity', name: 'OldName', parent: null, components: {} } as EditorOp);
    const ids = childrenOf(gateway.doc, null);
    expect(ids.length).toBe(1);
    const id = ids[0]!;

    expect(entName(gateway.doc, id)).toBe('OldName');

    const r = gateway.dispatch({ kind: 'rename', entity: id, name: 'NewName' } as EditorOp);
    expect(r.ok).toBe(true);
    expect(entName(gateway.doc, id)).toBe('NewName');
  });

  it('rename is undoable and entName reverts', () => {
    gateway.dispatch({ kind: 'spawnEntity', name: 'Alpha', parent: null, components: {} } as EditorOp);
    const id = childrenOf(gateway.doc, null)[0]!;

    gateway.dispatch({ kind: 'rename', entity: id, name: 'Beta' } as EditorOp);
    expect(entName(gateway.doc, id)).toBe('Beta');

    gateway.undo();
    expect(entName(gateway.doc, id)).toBe('Alpha');
  });

  it('rename does not change selection', () => {
    gateway.dispatch({ kind: 'spawnEntity', name: 'Ent', parent: null, components: {} } as EditorOp);
    const id = childrenOf(gateway.doc, null)[0]!;
    gateway.dispatch({ kind: 'setSelection', id } as EditorOp);
    expect(getSelection()).toBe(id);

    gateway.dispatch({ kind: 'rename', entity: id, name: 'Renamed' } as EditorOp);
    expect(getSelection()).toBe(id);
    expect(entName(gateway.doc, id)).toBe('Renamed');
  });
});
