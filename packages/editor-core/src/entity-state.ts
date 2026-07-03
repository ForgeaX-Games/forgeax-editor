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
import { EditorHidden } from './components/EditorHidden';
import { getRegisteredComponents } from '@forgeax/engine-ecs';
import type { EntityId, EditSession, WorldType, EntityHandle } from './scene-types';
import { getInternals, type SessionInternals } from './edit-session';

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

// ── Popout entity cache ────────────────────────────────────────────────────
// In popout windows, the EditSession.world is a dead clone (structuredClone
// over BroadcastChannel strips engine handles). Entity reads must go through
// a snapshot-derived cache rather than world.get().

interface PopoutEntInfo {
  name: string;
  parent: EntityId | null;
  handle: number;
  /** Component name → component data dict. */
  components: Record<string, Record<string, unknown>>;
}

let _popoutCache: Map<EntityId, PopoutEntInfo> | null = null;

/** Populate the popout entity cache from EditorSnapshot.worldState.
 *  Called by store.ts applySnapshot on popout windows only. */
export function entPopulate(
  session: EditSession,
  entities: Array<{ id: EntityId; name: string; parent: EntityId | null; components: Record<string, unknown>; engineHandle: number }>,
): void {
  const m = new Map<EntityId, PopoutEntInfo>();
  for (const e of entities) {
    entMap(session, e.id, e.engineHandle as EntityHandle);
    const comps: Record<string, Record<string, unknown>> = {};
    for (const [k, v] of Object.entries(e.components)) {
      if (typeof v === 'object' && v !== null) comps[k] = v as Record<string, unknown>;
    }
    m.set(e.id, { name: e.name, parent: e.parent, handle: e.engineHandle, components: comps });
  }
  _popoutCache = m;
}

export function entClearPopoutCache(): void {
  _popoutCache = null;
}

/** True if the session's world reference is known dead (popout window).
 *  A popout window receives its EditSession over BroadcastChannel, whose
 *  structuredClone strips all methods — so the live World's `get` function is
 *  gone (and snapshots now carry an explicit null world). On the main window
 *  `world.get` is a real method. This is a reliable liveness discriminator (the
 *  World class exposes no plain-data `rootEntities` field to test against). */
export function entIsDeadWorld(session: EditSession): boolean {
  try {
    const w = session.world as unknown as { get?: unknown } | null;
    return !w || typeof w.get !== 'function';
  } catch {
    return true;
  }
}
// Internal alias kept for the existing call sites below.
const _isDeadWorld = entIsDeadWorld;

// ── Entity info accessors (main = world, popout = cache) ────────────────────

export function entName(session: EditSession, id: EntityId): string {
  // Discriminate strictly on world liveness: a populated (module-level) popout
  // cache must NOT shadow live main-window reads — gating on the cache being
  // non-null leaked stale popout state into the main session. Dead world (popout
  // structuredClone) → cache; live world → read from world (SSOT).
  if (_isDeadWorld(session)) {
    if (_popoutCache) {
      const c = _popoutCache.get(id);
      if (c) return c.name;
    }
    return `#${id}`;
  }
  // Main window: read from world
  const h = entHandle(session, id);
  if (h === undefined) return `#${id}`;
  try {
    const r = session.world.get(h, Name);
    if (r.ok) return r.value.value;
  } catch { /* fall through */ }
  return `#${id}`;
}

export function entParent(session: EditSession, id: EntityId): EntityId | null {
  if (_isDeadWorld(session)) {
    if (_popoutCache) {
      const c = _popoutCache.get(id);
      if (c) return c.parent;
    }
    return null;
  }
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
  if (_isDeadWorld(session)) {
    return _popoutCache !== null && _popoutCache.has(id);
  }
  const h = entHandle(session, id);
  if (h === undefined) return false;
  try {
    return session.world.get(h, Name).ok;
  } catch {
    return false;
  }
}

/** Get a specific component's value dict from world (main) or popout cache. */
export function entComponent(
  session: EditSession,
  id: EntityId,
  compName: string,
): Record<string, unknown> | undefined {
  if (_isDeadWorld(session)) {
    if (_popoutCache) {
      const c = _popoutCache.get(id);
      if (c && compName in c.components) return c.components[compName];
    }
    return undefined;
  }
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

/** Get entity components dict (component name → value) from popout cache
 *  (popout) or by walking the engine component registry against the world
 *  (main). M7: replaces EntityNode.components. */
export function entComponents(session: EditSession, id: EntityId): Record<string, unknown> {
  if (_isDeadWorld(session)) {
    if (_popoutCache) {
      const c = _popoutCache.get(id);
      if (c) {
        const flat: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(c.components)) flat[k] = v;
        return flat;
      }
    }
    return {};
  }
  // Main window: walk registered components and probe the world for presence.
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