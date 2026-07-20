import { describe, it, expect, beforeEach } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import {
  createEditSession,
  gateway,
  childrenOf,
  entName,
} from '@forgeax/editor-core';
import type { EditorOp, EditSession } from '@forgeax/editor-core';

function createSession(): EditSession {
  const session = createEditSession();
  session.world = new World();
  return session;
}

describe('Entity existence check uses _e2h mapping, not Name component', () => {
  beforeEach(() => {
    gateway.replaceDoc(createSession());
  });

  it('removeComponent rejects removing Name (PROTECTED_COMPONENT)', () => {
    gateway.dispatch({ kind: 'spawnEntity', name: 'Ent', parent: null, components: {} } as EditorOp);
    const id = childrenOf(gateway.activeWorld, null)[0]!;

    const r = gateway.dispatch({ kind: 'removeComponent', entity: id, component: 'Name' } as EditorOp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PROTECTED_COMPONENT');
    expect(entName(gateway.activeWorld, id)).toBe('Ent');
  });

  it('ops on valid entity succeed regardless of Name presence (entityMapped)', () => {
    gateway.dispatch({ kind: 'spawnEntity', name: 'Box', parent: null, components: {} } as EditorOp);
    const id = childrenOf(gateway.activeWorld, null)[0]!;

    const r1 = gateway.dispatch({ kind: 'rename', entity: id, name: 'Cube' } as EditorOp);
    expect(r1.ok).toBe(true);
    expect(entName(gateway.activeWorld, id)).toBe('Cube');

    const r2 = gateway.dispatch({ kind: 'setHidden', entity: id, hidden: true } as EditorOp);
    expect(r2.ok).toBe(true);

    const r3 = gateway.dispatch({ kind: 'setHidden', entity: id, hidden: false } as EditorOp);
    expect(r3.ok).toBe(true);
  });

  it('ops on non-existent entity return NO_SUCH_ENTITY', () => {
    const fakeId = 9999;
    const r1 = gateway.dispatch({ kind: 'rename', entity: fakeId, name: 'X' } as EditorOp);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.code).toBe('NO_SUCH_ENTITY');

    const r2 = gateway.dispatch({ kind: 'removeComponent', entity: fakeId, component: 'Transform' } as EditorOp);
    expect(r2.ok).toBe(false);

    const r3 = gateway.dispatch({ kind: 'setHidden', entity: fakeId, hidden: true } as EditorOp);
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.error.code).toBe('NO_SUCH_ENTITY');
  });

  it('removeComponent on Transform still works after entityMapped fix', () => {
    gateway.dispatch({ kind: 'spawnEntity', name: 'Ent', parent: null, components: {} } as EditorOp);
    const id = childrenOf(gateway.activeWorld, null)[0]!;

    const r = gateway.dispatch({ kind: 'removeComponent', entity: id, component: 'Transform' } as EditorOp);
    expect(r.ok).toBe(true);
  });
});
