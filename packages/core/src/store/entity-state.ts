// entity-state — lightweight entity handle mapping + popout cache (M7).
//
// feat-20260701-editor-world-container-doc-ecs-collapse M7 / AC-15:
// Replaces EntityNode/doc.entities dual-write mirror. On main window, reads
// entity name/parent/existence from world (SSOT). On popout windows (no
// usable world after structuredClone), reads from a module-level cache
// populated by store.ts applySnapshot from EditorSnapshot.worldState.
//
// Anchors:
//   requirements AC-15: EntityNode/doc.entities zero hits in source
//   plan-strategy S7 M7: type sweep

import { Name, ChildOf, Transform } from '@forgeax/engine-runtime';
// EditorHidden is editor-core's own marker component (plan-strategy §2 D-7), NOT
// an engine export — importing it from @forgeax/engine-runtime is the exact
// `Socket`-class regression AGENTS.md anti-pattern #5 warns about (would trip
// TS2305 under the strict engine-.d.ts typecheck gate).
import { EditorHidden } from '../components/EditorHidden';
import { getRegisteredComponents } from '@forgeax/engine-ecs';
import type { EntityId, EditSession, WorldType, EntityHandle } from '../scene/scene-types';
import { getInternals, type SessionInternals } from '../session/edit-session';

// ── Handle mapping ──────────────────────────────────────────────────────────

export function entHandle(session: EditSession, id: EntityId): EntityHandle | undefined {
  // The map stores the live engine handle as a raw number; brand it so callers
  // can pass the result straight into world.get/set/... (EntityHandle is a
  // branded number, so this stays assignable to any number-typed consumer).
  const h = getInternals(session)._e2h.get(id);
  return h === undefined ? undefined : (h as EntityHandle);
}

export function entLegacyId(session: EditSession, handle: EntityHandle): EntityId | undefined {
  return getInternals(session)._h2e.get(handle);
}

export function entExists(session: EditSession, id: EntityId): boolean {
  return getInternals(session)._e2h.has(id);
}

export function entIds(session: EditSession): EntityId[] {
  return [...getInternals(session)._e2h.keys()].sort((a, b) => a - b);
}

export function entHandles(session: EditSession): EntityHandle[] {
  return [...getInternals(session)._e2h.values()];
}

/** Root engine handles = mapped handles with no live `ChildOf` parent.
 *
 *  The engine `World` class exposes NO public `rootEntities` field (only a local
 *  var inside spawn paths + `WorldInspection.rootEntities`), so both worldToPack
 *  and buildWorldState previously read `w.rootEntities` = `undefined` at runtime
 *  → an empty root set → a scene that saves as nothing (an Edit≠Play data-loss
 *  bug, AGENTS.md anti-pattern #2). This helper derives roots from the SSOT: an
 *  entity is a root when it carries no `ChildOf`, or its `ChildOf.parent` is not
 *  a currently-mapped handle (detached parent). */
export function entRootHandles(session: EditSession, world: WorldType): EntityHandle[] {
  const internals = getInternals(session);
  const roots: EntityHandle[] = [];
  for (const h of internals._e2h.values()) {
    const co = world.get(h as EntityHandle, ChildOf);
    if (!co.ok || !internals._h2e.has((co.value as { parent: number }).parent as EntityHandle)) {
      roots.push(h as EntityHandle);
    }
  }
  return roots;
}

export function entMap(session: EditSession, id: EntityId, handle: EntityHandle): void {
  const internals: SessionInternals = getInternals(session);
  internals._e2h.set(id, handle);
  internals._h2e.set(handle, id);
}

export function entUnmap(session: EditSession, id: EntityId, handle: EntityHandle): void {
  const internals: SessionInternals = getInternals(session);
  internals._e2h.delete(id);
  internals._h2e.delete(handle);
}

export function entNextId(session: EditSession): EntityId {
  const internals: SessionInternals = getInternals(session);
  const id = internals._nextId;
  internals._nextId++;
  return id;
}

export function entSetNextId(session: EditSession, id: EntityId): void {
  getInternals(session)._nextId = id;
}

export function entGetNextId(session: EditSession): EntityId {
  return getInternals(session)._nextId;
}

// ── Entity info accessors (main = world, popout = cache) ────────────────────

/** Get entity name from live world (SSOT).
 *  M3: single-realm — dead-world branch deleted, world is always live. */
export function entName(session: EditSession, id: EntityId): string {
  // Read from world (SSOT)
  const h = entHandle(session, id);
  if (h === undefined) return `#${id}`;
  try {
    const r = session.world.get(h, Name);
    if (r.ok) return r.value.value;
  } catch { /* fall through */ }
  return `#${id}`;
}

export function entParent(session: EditSession, id: EntityId): EntityId | null {
  const h = entHandle(session, id);
  if (h === undefined) return null;
  try {
    const r = session.world.get(h, ChildOf);
    if (!r.ok) return null;
    const parentH = (r.value as { parent: number }).parent as EntityHandle;
    return entLegacyId(session, parentH) ?? null;
  } catch {
    return null;
  }
}

export function entAlive(session: EditSession, id: EntityId): boolean {
  const h = entHandle(session, id);
  if (h === undefined) return false;
  try {
    return session.world.get(h, Name).ok;
  } catch {
    return false;
  }
}

/** Get a specific component's value dict from world.
 *  M3: single-realm — world is always live. */
export function entComponent(
  session: EditSession,
  id: EntityId,
  compName: string,
): Record<string, unknown> | undefined {
  const h = entHandle(session, id);
  if (h === undefined) return undefined;
  // Try to resolve component token from engine registry
  // For known components like Name, Transform, ChildOf, use direct import
  if (compName === 'Name') {
    try {
      const r = session.world.get(h, Name);
      if (r.ok) return r.value as Record<string, unknown>;
    } catch { return undefined; }
  }
  if (compName === 'Transform') {
    try {
      const r = session.world.get(h, Transform);
      if (r.ok) return r.value as Record<string, unknown>;
    } catch { return undefined; }
  }
  // Dynamic: try resolveToken via getRegisteredComponents
  // This is slow — consumers should use inline world.get with known tokens
  return undefined;
}

/** Get entity components dict by walking the engine component registry
 *  against the live world. M7: replaces EntityNode.components.
 *  M3: single-realm — dead-world branch deleted, world is always live. */
export function entComponents(session: EditSession, id: EntityId): Record<string, unknown> {
  // Walk registered components and probe the world for presence.
  const h = entHandle(session, id);
  if (h === undefined) return {};
  const out: Record<string, unknown> = {};
  try {
    for (const [name, token] of getRegisteredComponents()) {
      const r = session.world.get(h, token as Parameters<typeof session.world.get>[1]);
      if (r.ok) out[name] = r.value;
    }
  } catch { /* fall through — return whatever we collected */ }
  return out;
}