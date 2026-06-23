// EditSession factory + engine-POD projection (plan-strategy D-6).
//
// The editor authors a scene as a rich entity map (`entities` keyed by editor
// `EntityId`, carrying name / parent / hidden / component values) plus the
// editor-local ID management (`nextLocalId` allocator + `order` spawn list).
// The engine never learns about any of that (A0 red line): it only consumes a
// pure `SceneAsset` POD. This module derives that POD projection from the
// authoring map and packages an EditSession whose `asset` is ALWAYS fresh (a
// getter that re-projects on access), so no stale-projection bookkeeping is
// needed across applyCommand / undo / redo / disk reload.

import type { SceneAsset, SceneEntity, LocalEntityId } from '@forgeax/engine-types';
import type { EditSession, EntityId, EntityNode } from './scene-types';

/**
 * Project the editor authoring map into the engine `SceneAsset` POD shape.
 *
 * One engine `SceneEntity` per NON-hidden authored entity; `localId` is the
 * entity's index in the emitted list (engine array-index semantics). The
 * entity's authored `components` are carried through verbatim, augmented with a
 * `Name` component (so names survive) and a `ChildOf` relationship derived from
 * the editor `parent` link (engine resolves `ChildOf.parent` as the parent's
 * localId). This is a PURE structural projection — no mesh/material handle
 * resolution (that is `instantiate`'s concern) and no editor-only field.
 */
export function projectSessionAsset(
  entities: Record<EntityId, EntityNode>,
  order: EntityId[],
): SceneAsset {
  // Emit entities in spawn order, skipping hidden ones (authoring-only aid).
  const emitted: EntityId[] = order.filter((id) => entities[id] && !entities[id]!.hidden);
  const localIdByEntityId = new Map<EntityId, number>();
  emitted.forEach((id, i) => localIdByEntityId.set(id, i));

  const sceneEntities: SceneEntity[] = emitted.map((id, i) => {
    const node = entities[id]!;
    const components: Record<string, Record<string, unknown>> = {};
    // Carry authored component values verbatim (engine consumes the same names).
    for (const [comp, value] of Object.entries(node.components)) {
      components[comp] = (value ?? {}) as Record<string, unknown>;
    }
    // Names survive via the engine Name component.
    if (node.name) components.Name = { value: node.name };
    // Hierarchy: editor parent link → engine ChildOf.parent (parent's localId).
    if (node.parent !== null && localIdByEntityId.has(node.parent)) {
      components.ChildOf = { parent: localIdByEntityId.get(node.parent)! };
    }
    return { localId: i as LocalEntityId, components };
  });

  return { kind: 'scene', entities: sceneEntities };
}

/**
 * Build an EditSession from its authoring state. `asset` is a getter so it is
 * always a fresh projection of the current `entities`/`order` — callers mutate
 * `entities`/`order`/`nextLocalId` (the source of truth) and read `asset`
 * whenever they need the engine POD view.
 */
export function makeEditSession(
  entities: Record<EntityId, EntityNode>,
  order: EntityId[],
  nextLocalId: EntityId,
): EditSession {
  const session = { entities, order, nextLocalId } as {
    entities: Record<EntityId, EntityNode>;
    order: EntityId[];
    nextLocalId: EntityId;
    asset?: SceneAsset;
  };
  Object.defineProperty(session, 'asset', {
    enumerable: true,
    get(): SceneAsset {
      return projectSessionAsset(session.entities, session.order);
    },
  });
  return session as EditSession;
}

/** A fresh, empty edit session (replaces the former `createDocument`). */
export function createEditSession(): EditSession {
  return makeEditSession({}, [], 1);
}
