// EditSession factory (M7: EntityNode + projection dead code deleted).
//
// feat-20260701-editor-world-container-doc-ecs-collapse M7 / AC-15:
// makeEditSession, projectSessionAsset, cloneEditSession deleted — all served
// the EntityNode/doc.entities dual-write mirror. createEditSession now only
// creates a new World instance (the SSOT).

import { World } from '@forgeax/engine-ecs';
import type { EditSession } from '../scene/scene-types';
import type { EntityId, EntityHandle } from '../scene/scene-types';

type WorldType = World;

/** Internal session state (not on EditSession interface — document.ts internal).
 *  Carries the legacy ID allocator + legacy ID → engine handle mapping that
 *  the command system needs for entity tracking and undo/redo. */
export interface SessionInternals {
  _nextId: EntityId;
  /** Legacy EntityId → engine handle (world.spawn return value). */
  _e2h: Map<EntityId, EntityHandle>;
  /** Engine handle → legacy EntityId (reverse lookup). */
  _h2e: Map<EntityHandle, EntityId>;
}

/** Mutable internal state stored as a non-enumerable symbol-keyed property
 *  on the EditSession object. External consumers only see the public
 *  EditSession interface ({world, registry}). */
const INTERNALS = Symbol('sessionInternals');

export function getInternals(session: EditSession): SessionInternals {
  const internals = (session as unknown as Record<symbol, SessionInternals | undefined>)[INTERNALS];
  if (internals === undefined) {
    throw new Error('EditSession missing internals — not created via createEditSession');
  }
  return internals;
}

/** A fresh, empty edit session with a new World.
 *  The edit-runtime replaces this default world with the real app world at
 *  boot via bus.doc.world = world. */
export function createEditSession(): EditSession {
  const world = new World();
  const session = {
    world: world as unknown as WorldType,
    [INTERNALS]: {
      _nextId: 1 as EntityId,
      _e2h: new Map<EntityId, EntityHandle>(),
      _h2e: new Map<EntityHandle, EntityId>(),
    } satisfies SessionInternals,
  };
  return session as unknown as EditSession;
}