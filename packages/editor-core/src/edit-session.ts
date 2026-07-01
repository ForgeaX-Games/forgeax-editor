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
  // Non-enumerable so the derived projection is NOT serialized onto the wire
  // (BroadcastChannel structuredClone / JSON.stringify skip it) — entities/order
  // are the only persisted source of truth, and receivers revive the getter via
  // makeEditSession. Direct `.asset` access still works.
  Object.defineProperty(session, 'asset', {
    enumerable: false,
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

/**
 * Deep-copy an EditSession for snapshot purposes (w14/w15 — plan-strategy D-3).
 *
 * The clone is a true fork: mutations to the original do not affect the snapshot
 * and vice versa. EntityNode fields (components / source / hidden) are deep-copied
 * via structuredClone so the snapshot carries no reference-sharing with the live
 * session. The `asset` getter is revived via makeEditSession.
 *
 * This is called at ▶ click (snapshot once — requirements AC-07), then stored
 * until ■ Stop for replaceDoc-based restore.
 */
export function cloneEditSession(session: EditSession): EditSession {
  const entities: Record<EntityId, EntityNode> = {};
  for (const [id, node] of Object.entries(session.entities)) {
    const nid = Number(id) as EntityId;
    entities[nid] = {
      id: node.id,
      name: node.name,
      parent: node.parent,
      components: structuredClone(node.components) as Record<string, unknown>,
      ...(node.source ? { source: structuredClone(node.source) } : {}),
      ...(node.hidden !== undefined ? { hidden: node.hidden } : {}),
    };
  }
  return makeEditSession(entities, [...session.order], session.nextLocalId);
}
