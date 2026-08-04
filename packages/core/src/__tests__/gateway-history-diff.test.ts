// R3-05 — the public review projection is derived from the existing undo/redo
// entries. It must keep human/AI origin, preserve replay order across the
// applied/future boundary, and never create a second mutation path.

import { describe, expect, it } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { EditGateway } from '../io/gateway';
import { createEditSession } from '../session/document';
import type { EditorOp, EditSession } from '../types';

function createSession(): EditSession {
  const session = createEditSession();
  session.world = new World();
  return session;
}

describe('EditGateway historyDiff', () => {
  it('projects forward/inverse commands with actor and future state', () => {
    const gateway = new EditGateway(createSession());
    const spawn: EditorOp = { kind: 'spawnEntity', name: 'review fixture' };
    expect(gateway.dispatch(spawn, 'ai').ok).toBe(true);
    const entity = (spawn as { _id?: number })._id;
    if (typeof entity !== 'number') throw new Error('spawn did not expose an entity handle');

    const rename: EditorOp = { kind: 'rename', entity, name: 'reviewed fixture' };
    expect(gateway.dispatch(rename, 'ai').ok).toBe(true);

    expect(gateway.historyDiff(1)).toMatchObject({
      index: 1,
      label: 'spawnEntity',
      origin: 'ai',
      future: false,
      op: { kind: 'spawnEntity', name: 'review fixture', _id: entity },
      inverse: { kind: 'destroyEntity', entity },
    });
    expect(gateway.historyDiff(2)).toMatchObject({
      index: 2,
      label: 'rename',
      origin: 'ai',
      future: false,
      op: rename,
      inverse: { kind: 'rename', entity, name: 'review fixture' },
    });

    gateway.jumpTo(1);
    expect(gateway.historyDiff(2)).toMatchObject({
      index: 2,
      origin: 'ai',
      future: true,
      op: rename,
      inverse: { kind: 'rename', entity, name: 'review fixture' },
    });
    expect(gateway.historyDiff(0)).toBeUndefined();
    expect(gateway.historyDiff(3)).toBeUndefined();
  });
});
