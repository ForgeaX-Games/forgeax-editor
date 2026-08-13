// Editor-side animation binding for imported SceneInstance trees.
//
// AnimationTargetId is authored on the skeleton joints, while an imported
// Skin entity is often only the mesh holder. The engine deliberately does not
// infer that relationship: AnimationPlayer must be rooted above every target
// and must be bound explicitly. Keep that policy in the engine; this module is
// the editor's importer/preview adapter that chooses the correct animation
// root and performs the explicit bind.

import {
  AnimatedBy,
  AnimationPlayer,
  AnimationTargetId,
  AnimationTargets,
  bindAnimationTargets,
} from '@forgeax/engine-animation';
import {
  ENTITY_NULL_RAW,
  Entity,
  type EntityHandle,
  type World,
} from '@forgeax/engine-ecs';
import { ChildOf } from '@forgeax/engine-scene';
import { SceneInstance } from '@forgeax/engine-render';
import { Skin } from '@forgeax/engine-skinning';
import { queryEachIncludingDisabled } from '../store/entity-state';

export interface AnimationTargetBindingMove {
  readonly from: EntityHandle;
  readonly to: EntityHandle;
  readonly targetCount: number;
}

export interface AnimationTargetBindingFailure {
  readonly player: EntityHandle;
  readonly code: string;
  readonly detail?: unknown;
}

export interface AnimationTargetBindingReport {
  readonly root: EntityHandle | null;
  readonly targetCount: number;
  readonly boundCount: number;
  readonly changed: boolean;
  readonly players: readonly EntityHandle[];
  readonly moved: readonly AnimationTargetBindingMove[];
  readonly failures: readonly AnimationTargetBindingFailure[];
}

export interface AnimationTargetBindingError {
  readonly code: 'animation-target-binding-failed';
  readonly hint: string;
  readonly detail: readonly AnimationTargetBindingFailure[];
}

export interface AnimationTargetBindingOptions {
  /** The write gate bound to the world being repaired. */
  readonly mutation: AnimationTargetBindingMutation;
  /** Add a player for a Skin when the imported scene has no player yet. */
  readonly ensurePlayerForSkin?: boolean;
  /** A host-created player which must be considered for this scene first. */
  readonly player?: EntityHandle;
}

/**
 * The binding pass needs to move/replace AnimationPlayer rows and clear the
 * transient relationship mirror. Keep those writes on the caller's
 * EngineFacade instead of reaching around the editor write gate from this
 * topology helper. The engine-owned bindAnimationTargets call remains the
 * canonical relationship binder.
 */
export type AnimationTargetBindingMutation = Pick<World, 'set' | 'addComponent' | 'removeComponent'>;

interface PlayerCandidate {
  readonly entity: EntityHandle;
  readonly skinTargets: readonly EntityHandle[];
  readonly priority: number;
}

interface MutableReport {
  root: EntityHandle | null;
  targetCount: number;
  boundCount: number;
  changed: boolean;
  players: EntityHandle[];
  moved: AnimationTargetBindingMove[];
  failures: AnimationTargetBindingFailure[];
}

function report(root: EntityHandle | null): MutableReport {
  return {
    root,
    targetCount: 0,
    boundCount: 0,
    changed: false,
    players: [],
    moved: [],
    failures: [],
  };
}

function finish(value: MutableReport): AnimationTargetBindingReport {
  return {
    root: value.root,
    targetCount: value.targetCount,
    boundCount: value.boundCount,
    changed: value.changed,
    players: value.players,
    moved: value.moved,
    failures: value.failures,
  };
}

function live(world: World, entity: EntityHandle): boolean {
  return world.get(entity, Entity).ok;
}

function parentOf(world: World, entity: EntityHandle): EntityHandle | null {
  const parent = world.get(entity, ChildOf);
  if (!parent.ok) return null;
  const raw = parent.value.parent as EntityHandle | null;
  if (raw === null || (raw as unknown as number) === ENTITY_NULL_RAW) return null;
  return raw;
}

/** Return the chain from the entity upward, deepest first. */
function lineage(world: World, entity: EntityHandle): EntityHandle[] {
  const result: EntityHandle[] = [];
  const visited = new Set<number>();
  let current: EntityHandle | null = entity;
  while (current !== null && !visited.has(current as number)) {
    visited.add(current as number);
    if (!live(world, current)) break;
    result.push(current);
    current = parentOf(world, current);
  }
  return result;
}

function isAncestor(world: World, ancestor: EntityHandle, entity: EntityHandle): boolean {
  return lineage(world, entity).includes(ancestor);
}

/** Find the true deepest common entity that can legally own one AnimationPlayer. */
function lowestCommonAncestor(
  world: World,
  targets: readonly EntityHandle[],
  allowed?: ReadonlySet<number>,
): EntityHandle | null {
  const first = targets[0];
  if (first === undefined) return null;
  let common = lineage(world, first);
  for (const target of targets.slice(1)) {
    const other = new Set(lineage(world, target) as readonly EntityHandle[]);
    common = common.filter((candidate) => other.has(candidate));
    if (common.length === 0) return null;
  }
  // A target entity is also a legal player root. In particular, imported rigs
  // may stamp AnimationTargetId on the skeleton root itself. Never promote the
  // player to the transient SceneInstance wrapper in that case: the wrapper is
  // not a mapped authored member and cannot round-trip through mount overrides.
  return common.find((candidate) => allowed === undefined || allowed.has(candidate as number)) ?? null;
}

function mappedEntities(world: World, root: EntityHandle): EntityHandle[] {
  const instance = world.get(root, SceneInstance);
  if (!instance.ok) return [];
  const result: EntityHandle[] = [];
  const mapping = instance.value.mapping as ArrayLike<number>;
  for (let i = 0; i < mapping.length; i++) {
    const raw = mapping[i];
    if (raw === ENTITY_NULL_RAW) continue;
    const entity = raw as EntityHandle;
    if (live(world, entity)) result.push(entity);
  }
  return result;
}

function targetEntities(world: World, entities: readonly EntityHandle[]): EntityHandle[] {
  return entities.filter((entity) => world.get(entity, AnimationTargetId).ok);
}

function skinTargetEntities(world: World, skin: EntityHandle): EntityHandle[] {
  const value = world.get(skin, Skin);
  if (!value.ok) return [];
  const joints = (value.value as { joints?: ArrayLike<number> }).joints;
  if (joints === undefined) return [];
  const result: EntityHandle[] = [];
  for (let i = 0; i < joints.length; i++) {
    const raw = joints[i];
    if (raw === ENTITY_NULL_RAW) continue;
    const entity = raw as EntityHandle;
    if (live(world, entity) && world.get(entity, AnimationTargetId).ok) result.push(entity);
  }
  return result;
}

function skinTargetsOrFallback(
  world: World,
  skin: EntityHandle,
  fallback: readonly EntityHandle[],
): EntityHandle[] {
  const joints = skinTargetEntities(world, skin);
  if (!world.get(skin, Skin).ok) return joints;
  // Some importers populate Skin.skeleton first and let the normal runtime
  // resolver fill Skin.joints on a later frame. A single-Skin scene still has
  // an unambiguous target set at this point, so do not wait a frame and emit
  // animation-target-missing diagnostics in the meantime.
  return joints.length > 0 ? joints : [...fallback];
}

function hasLiveAnimationHandle(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  return typeof value === 'number' ? value !== 0 : true;
}

function playerActivityScore(world: World, player: EntityHandle): number {
  const value = world.get(player, AnimationPlayer);
  if (!value.ok) return 0;
  const data = value.value as { clips?: ArrayLike<unknown>; graph?: unknown };
  let score = hasLiveAnimationHandle(data.graph) ? 1 : 0;
  if (data.clips !== undefined) {
    for (let i = 0; i < data.clips.length; i++) {
      if (hasLiveAnimationHandle(data.clips[i])) score += 1;
    }
  }
  return score;
}

function playerData(world: World, player: EntityHandle): unknown {
  const value = world.get(player, AnimationPlayer);
  if (!value.ok) return null;
  return structuredClone(value.value);
}

function clearPlayerBinding(world: World, mutation: AnimationTargetBindingMutation, player: EntityHandle): void {
  const mirror = world.get(player, AnimationTargets);
  if (mirror.ok) {
    const targets = mirror.value.targets as ArrayLike<number>;
    for (let i = 0; i < targets.length; i++) {
      const raw = targets[i];
      if (raw === ENTITY_NULL_RAW) continue;
      const target = raw as EntityHandle;
      const owner = world.get(target, AnimatedBy);
      if (owner.ok && owner.value.player === player) {
        mutation.removeComponent(target, AnimatedBy);
      }
    }
    mutation.removeComponent(player, AnimationTargets);
  }
}

/**
 * Move an authored player off a mesh holder and onto the skeleton LCA. A
 * destination player with no active clips is treated as an importer-created
 * placeholder and may be replaced; two active players are a real authoring
 * conflict and stay fail-closed.
 */
function movePlayer(
  world: World,
  mutation: AnimationTargetBindingMutation,
  from: EntityHandle,
  to: EntityHandle,
): { ok: true; player: EntityHandle; changed: boolean } | { ok: false; code: string; detail: unknown } {
  if (from === to) return { ok: true, player: from, changed: false };
  const sourceData = playerData(world, from);
  if (sourceData === null) {
    return { ok: false, code: 'animation-target-player-invalid', detail: { player: from as number } };
  }

  const destination = world.get(to, AnimationPlayer);
  if (destination.ok) {
    const sourceClips = playerActivityScore(world, from);
    const destinationClips = playerActivityScore(world, to);
    if (sourceClips > 0 && destinationClips > 0) {
      return {
        ok: false,
        code: 'animation-target-player-conflict',
        detail: { from: from as number, to: to as number },
      };
    }
    if (sourceClips === 0 && destinationClips > 0) {
      clearPlayerBinding(world, mutation, from);
      mutation.removeComponent(from, AnimationPlayer);
      return { ok: true, player: to, changed: true };
    }
    clearPlayerBinding(world, mutation, to);
    const set = mutation.set(to, AnimationPlayer, sourceData as never);
    if (!set.ok) {
      return { ok: false, code: 'animation-target-bind-failed', detail: set.error };
    }
  } else {
    const added = mutation.addComponent(to, {
      component: AnimationPlayer,
      data: sourceData as never,
    });
    if (!added.ok) {
      return { ok: false, code: 'animation-target-bind-failed', detail: added.error };
    }
  }

  clearPlayerBinding(world, mutation, from);
  mutation.removeComponent(from, AnimationPlayer);
  return { ok: true, player: to, changed: true };
}

function addEmptyPlayer(world: World, mutation: AnimationTargetBindingMutation, entity: EntityHandle): boolean {
  if (world.get(entity, AnimationPlayer).ok) return true;
  const added = mutation.addComponent(entity, {
    component: AnimationPlayer,
    data: {
      clips: [],
      times: new Float32Array(0),
      weights: new Float32Array(0),
      speeds: new Float32Array(0),
      paused: false,
      looping: true,
    },
  });
  return added.ok;
}

function addCandidate(
  candidates: Map<number, PlayerCandidate>,
  world: World,
  entity: EntityHandle,
  skinTargets: readonly EntityHandle[],
  priority: number,
): void {
  if (!world.get(entity, AnimationPlayer).ok) return;
  const previous = candidates.get(entity as number);
  if (previous === undefined || priority < previous.priority || skinTargets.length > previous.skinTargets.length) {
    candidates.set(entity as number, { entity, skinTargets, priority });
  }
}

function canBindToPlayer(
  world: World,
  player: EntityHandle,
  targets: readonly EntityHandle[],
): { bindable: EntityHandle[]; conflicts: Array<{ target: EntityHandle; owner: EntityHandle }> } {
  const bindable: EntityHandle[] = [];
  const conflicts: Array<{ target: EntityHandle; owner: EntityHandle }> = [];
  for (const target of targets) {
    if (!isAncestor(world, player, target)) continue;
    const owner = world.get(target, AnimatedBy);
    if (
      owner.ok &&
      owner.value.player !== null &&
      owner.value.player !== player &&
      live(world, owner.value.player)
    ) {
      conflicts.push({ target, owner: owner.value.player });
      continue;
    }
    bindable.push(target);
  }
  return { bindable, conflicts };
}

function needsBind(world: World, player: EntityHandle, targets: readonly EntityHandle[]): boolean {
  return targets.some((target) => {
    if (!world.get(target, AnimationTargetId).ok) return true;
    const owner = world.get(target, AnimatedBy);
    return !owner.ok || owner.value.player !== player;
  });
}

function bindPlayerCandidate(
  world: World,
  mutation: AnimationTargetBindingMutation,
  root: EntityHandle | null,
  candidate: PlayerCandidate,
  allTargets: readonly EntityHandle[],
  value: MutableReport,
  persistableMembers?: ReadonlySet<number>,
): void {
  let targets = candidate.skinTargets.length > 0
    ? [...candidate.skinTargets]
    : allTargets.filter((target) => isAncestor(world, candidate.entity, target));
  if (targets.length === 0) return;

  let player = candidate.entity;
  const canReachAll = targets.every((target) => isAncestor(world, player, target));
  if (!canReachAll) {
    const destination = lowestCommonAncestor(world, targets, persistableMembers)
      ?? (root !== null && persistableMembers === undefined && targets.every((target) => isAncestor(world, root, target)) ? root : null);
    if (destination === null) {
      value.failures.push({
        player,
        code: 'animation-target-outside-player-root',
        detail: { player: player as number, targetCount: targets.length },
      });
      return;
    }
    const moved = movePlayer(world, mutation, player, destination);
    if (!moved.ok) {
      value.failures.push({ player, code: moved.code, detail: moved.detail });
      return;
    }
    player = moved.player;
    if (moved.changed) {
      value.changed = true;
      value.moved.push({ from: candidate.entity, to: player, targetCount: targets.length });
    }
    // The destination may already have a player. Re-evaluate the legal target
    // subset after the move rather than passing an out-of-root entity to the
    // engine binder.
    targets = targets.filter((target) => isAncestor(world, player, target));
  }

  const ownership = canBindToPlayer(world, player, targets);
  if (ownership.conflicts.length > 0) {
    value.failures.push({
      player,
      code: 'animation-target-player-conflict',
      detail: {
        targets: ownership.conflicts.map(({ target }) => target as number),
        owners: ownership.conflicts.map(({ owner }) => owner as number),
      },
    });
  }
  const bindable = ownership.bindable;
  if (bindable.length === 0) return;
  const changedBeforeBind = needsBind(world, player, bindable);
  const bound = bindAnimationTargets(world, player, bindable);
  if (!bound.ok) {
    value.failures.push({ player, code: bound.error.code, detail: bound.error.detail });
    return;
  }
  if (changedBeforeBind) value.changed = true;
  value.boundCount += bindable.length;
  if (!value.players.includes(player)) value.players.push(player);
}

/** Bind the AnimationTargetId rows belonging to one SceneInstance. */
export function bindSceneInstanceAnimationTargets(
  world: World,
  sceneInstanceRoot: EntityHandle,
  options: AnimationTargetBindingOptions,
): AnimationTargetBindingReport {
  const value = report(sceneInstanceRoot);
  const members = mappedEntities(world, sceneInstanceRoot);
  const allTargets = targetEntities(world, members);
  value.targetCount = allTargets.length;
  if (allTargets.length === 0) return finish(value);
  const skinMembers = members.filter((member) => world.get(member, Skin).ok);
  const singleSkinFallback = skinMembers.length === 1 ? allTargets : [];
  const persistableMembers = new Set(members.map((member) => member as number));

  const candidates = new Map<number, PlayerCandidate>();
  if (options.player !== undefined) {
    addCandidate(candidates, world, options.player, skinTargetsOrFallback(world, options.player, singleSkinFallback), 0);
  }
  for (const member of members) {
    const skinTargets = skinTargetsOrFallback(world, member, singleSkinFallback);
    if (skinTargets.length > 0) addCandidate(candidates, world, member, skinTargets, 2);
  }
  for (const member of members) {
    addCandidate(candidates, world, member, [], 3);
  }

  const ordered = [...candidates.values()].sort((a, b) => {
    const activity = playerActivityScore(world, b.entity) - playerActivityScore(world, a.entity);
    if (activity !== 0) return activity;
    const priority = a.priority - b.priority;
    if (priority !== 0) return priority;
    return (b.skinTargets.length - a.skinTargets.length);
  });
  for (const candidate of ordered) {
    bindPlayerCandidate(world, options.mutation, sceneInstanceRoot, candidate, allTargets, value, persistableMembers);
  }

  if (options.ensurePlayerForSkin === true) {
    for (const member of members) {
      if (!world.get(member, Skin).ok) continue;
      const targets = skinTargetsOrFallback(world, member, singleSkinFallback);
      if (targets.length === 0) continue;
      const destination = lowestCommonAncestor(world, targets, persistableMembers);
      if (destination === null) {
        value.failures.push({
          player: member,
          code: 'animation-target-outside-player-root',
          detail: { targetCount: targets.length, reason: 'no-mapped-animation-root' },
        });
        continue;
      }
      if (!world.get(destination, AnimationPlayer).ok) {
        if (!addEmptyPlayer(world, options.mutation, destination)) {
          value.failures.push({ player: destination, code: 'animation-target-bind-failed' });
          continue;
        }
        value.changed = true;
      }
      bindPlayerCandidate(world, options.mutation, sceneInstanceRoot, {
        entity: destination,
        skinTargets: targets,
        priority: 4,
      }, allTargets, value, persistableMembers);
    }
  }
  return finish(value);
}

/**
 * Resolve the authored closure rooted at a staged entity set. A load or flat
 * instantiate can temporarily coexist with an older scene in the same World;
 * the binding pass must not let that older tree contribute skins, targets, or
 * standalone players to the new scene's fallback decisions.
 */
function scopedEntityIds(world: World, roots: readonly EntityHandle[]): ReadonlySet<number> {
  const allEntities: EntityHandle[] = [];
  queryEachIncludingDisabled(world, [Entity], (entity) => allEntities.push(entity as EntityHandle));
  const scoped = new Set<number>();
  const frontier: EntityHandle[] = [];
  for (const root of roots) {
    if (!live(world, root) || scoped.has(root as number)) continue;
    scoped.add(root as number);
    frontier.push(root);
  }

  for (let i = 0; i < frontier.length; i++) {
    const root = frontier[i]!;
    for (const entity of allEntities) {
      if (scoped.has(entity as number) || !isAncestor(world, root, entity)) continue;
      scoped.add(entity as number);
      frontier.push(entity);
    }
    for (const member of mappedEntities(world, root)) {
      if (scoped.has(member as number)) continue;
      scoped.add(member as number);
      frontier.push(member);
    }
  }
  return scoped;
}

/** Bind every SceneInstance in a world, then repair standalone flat players. */
export function bindAllSceneAnimationTargets(
  world: World,
  options: Omit<AnimationTargetBindingOptions, 'player'>,
  scopeRoots?: readonly EntityHandle[],
): readonly AnimationTargetBindingReport[] {
  const scope = scopeRoots === undefined ? undefined : scopedEntityIds(world, scopeRoots);
  const inScope = (entity: EntityHandle): boolean => scope === undefined || scope.has(entity as number);
  const roots: EntityHandle[] = [];
  queryEachIncludingDisabled(world, [SceneInstance, Entity], (entity) => {
    if (inScope(entity as EntityHandle)) roots.push(entity as EntityHandle);
  });

  const reports: AnimationTargetBindingReport[] = [];
  const handledPlayers = new Set<number>();
  for (const root of roots) {
    const current = bindSceneInstanceAnimationTargets(world, root, options);
    reports.push(current);
    for (const player of current.players) handledPlayers.add(player as number);
  }

  const standalonePlayers: EntityHandle[] = [];
  queryEachIncludingDisabled(world, [AnimationPlayer, Entity], (entity) => {
    if (!inScope(entity as EntityHandle) || world.get(entity as EntityHandle, SceneInstance).ok) return;
    if (!handledPlayers.has(entity)) standalonePlayers.push(entity as EntityHandle);
  });
  const allTargets: EntityHandle[] = [];
  queryEachIncludingDisabled(world, [AnimationTargetId, Entity], (entity) => {
    if (inScope(entity as EntityHandle)) allTargets.push(entity as EntityHandle);
  });
  const allSkins: EntityHandle[] = [];
  queryEachIncludingDisabled(world, [Skin, Entity], (entity) => {
    if (inScope(entity as EntityHandle)) allSkins.push(entity as EntityHandle);
  });
  const standaloneSkinFallback = allSkins.length === 1 ? allTargets : [];
  for (const player of standalonePlayers) {
    const current = report(null);
    current.targetCount = allTargets.filter((target) => isAncestor(world, player, target)).length;
    const skinTargets = skinTargetsOrFallback(world, player, standaloneSkinFallback);
    bindPlayerCandidate(world, options.mutation, null, {
      entity: player,
      skinTargets,
      priority: 0,
    }, allTargets, current);
    reports.push(finish(current));
  }
  return reports;
}
