import { beforeEach, describe, expect, it } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import { EditGateway } from '../io/gateway';
import { createEditSession } from '../session/document';
import { Visibility, VisibilityStateValue } from '../visibility';
import type { EditSession, EditorOp } from '../types';
import type { EntityHandle } from '../scene/scene-types';
import { entName, worldEntityHandles } from '../store/entity-state';
import '../store/store';

function session(): EditSession {
  const value = createEditSession();
  value.world = new World();
  return value;
}

function spawn(gateway: EditGateway, name: string, parent: EntityHandle | null = null): EntityHandle {
  const op: EditorOp = {
    kind: 'spawnEntity',
    name,
    parent,
    components: { Transform: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
  };
  const result = gateway.dispatch(op);
  if (!result.ok || result.result?.created[0] === undefined) throw new Error('spawn failed');
  return result.result.created[0];
}

describe('Runtime-owned hierarchyGesture', () => {
  let gateway: EditGateway;

  beforeEach(() => { gateway = new EditGateway(session()); });

  it('plans a compound reparent at the authority and undoes it in one step', () => {
    const parent = spawn(gateway, 'Parent');
    const child = spawn(gateway, 'Child');
    const before = gateway.appliedCount();
    const result = gateway.dispatch({
      kind: 'hierarchyGesture',
      action: 'reparent',
      entities: [child],
      parent,
    }, 'ai');
    expect(result.ok).toBe(true);
    expect(gateway.appliedCount()).toBe(before + 1);
    const linked = gateway.activeWorld.get(child, ChildOf);
    expect(linked.ok && linked.value.parent).toBe(parent);
    expect(gateway.undo()).toBe(true);
    expect(gateway.activeWorld.get(child, ChildOf).ok).toBe(false);
  });

  it('deduplicates cascade roots and keeps a batch visibility gesture atomic', () => {
    const parent = spawn(gateway, 'Parent');
    const child = spawn(gateway, 'Child', parent);
    const sibling = spawn(gateway, 'Sibling');
    expect(gateway.dispatch({
      kind: 'hierarchyGesture',
      action: 'visibility',
      entities: [parent, sibling],
      state: 'hidden',
    }).ok).toBe(true);
    const parentVisibility = gateway.activeWorld.get(parent, Visibility);
    const siblingVisibility = gateway.activeWorld.get(sibling, Visibility);
    expect(parentVisibility.ok && parentVisibility.value.state).toBe(VisibilityStateValue.hidden);
    expect(siblingVisibility.ok && siblingVisibility.value.state).toBe(VisibilityStateValue.hidden);
    expect(gateway.undo()).toBe(true);

    expect(gateway.dispatch({
      kind: 'hierarchyGesture',
      action: 'delete',
      entities: [parent, child],
    }).ok).toBe(true);
    expect(gateway.activeWorld.get(parent, Transform).ok).toBe(false);
    expect(gateway.activeWorld.get(child, Transform).ok).toBe(false);
    expect(gateway.undo()).toBe(true);
    expect(worldEntityHandles(gateway.activeWorld).map((entity) => entName(gateway.activeWorld, entity)).sort())
      .toEqual(['Child', 'Parent', 'Sibling']);
  });
});
