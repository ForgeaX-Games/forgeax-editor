import type { AssetWorkspaceSnapshot, AssetPreflightResult } from '@forgeax/editor-core';
import type { SceneReadModel } from '@forgeax/editor-core';

/**
 * Delete-guard impact analysis (C3) — before destroying assets we ask the
 * reverse dependency index (C2) "who still points at these?". Assets that are
 * part of the same delete batch don't count (deleting a pair that reference
 * each other is safe), so only *external* referencers raise a warning, mirroring
 * the delete-protection dialogs in UE / Godot.
 */
export interface DeleteImpact {
  /** guid → external referencer guids (referencers NOT in the delete batch). */
  externalReferencers: Map<string, string[]>;
  /** True when at least one target is still referenced from outside the batch. */
  hasExternalReferencers: boolean;
  /** Total distinct external referencer guids across all targets. */
  externalReferencerCount: number;
}

export interface DeletePreflightSummary {
  readonly currentRevision: string;
  readonly recoveryActions: readonly string[];
  readonly blocked: boolean;
}

export interface SceneDeleteGuard {
  readonly reasons: readonly ('current' | 'default' | 'referenced')[];
  readonly referencers: readonly string[];
}

/** Project the authoritative scene read model and workspace refs into the
 * human confirmation surface. The Gateway remains the final guard; this is the
 * preflight projection that lets a human see why confirmation is unavailable. */
export function computeSceneDeleteGuards(
  targets: readonly { guid: string; kind: string }[],
  sceneModel: SceneReadModel,
  workspace: AssetWorkspaceSnapshot,
): Map<string, SceneDeleteGuard> {
  const sceneTargets = targets.filter((target) => target.kind === 'scene');
  const impact = computeDeleteImpact(sceneTargets.map((target) => target.guid), workspace);
  const guards = new Map<string, SceneDeleteGuard>();
  for (const target of sceneTargets) {
    const scene = sceneModel.scenes.find((entry) => entry.guid === target.guid);
    const referencers = impact.externalReferencers.get(target.guid) ?? [];
    const reasons: SceneDeleteGuard['reasons'][number][] = [];
    if (scene?.isCurrent) reasons.push('current');
    if (scene?.isDefault) reasons.push('default');
    if (referencers.length > 0) reasons.push('referenced');
    if (reasons.length > 0) guards.set(target.guid, { reasons, referencers });
  }
  return guards;
}

export function summarizeDeletePreflight(
  preflights: readonly AssetPreflightResult[],
): DeletePreflightSummary {
  const blocked = preflights.some((entry) => !entry.ok);
  return {
    currentRevision: preflights[0]?.currentRevision ?? 'unknown',
    recoveryActions: [...new Set(preflights.flatMap((entry) => entry.recoveryActions))].sort(),
    blocked,
  };
}

/**
 * Compute which of `targetGuids` are still referenced by assets outside the
 * delete batch. Pure and side-effect free for unit testing.
 */
export function computeDeleteImpact(
  targetGuids: readonly string[],
  workspace: AssetWorkspaceSnapshot,
): DeleteImpact {
  const batch = new Set(targetGuids);
  const externalReferencers = new Map<string, string[]>();
  const distinctExternal = new Set<string>();

  for (const guid of targetGuids) {
    const refs = workspace.relations
      .filter((relation) => relation.kind === 'depends-on' && relation.to === guid)
      .map((relation) => relation.from);
    const external = refs.filter((r) => !batch.has(r));
    if (external.length > 0) {
      externalReferencers.set(guid, external);
      for (const r of external) distinctExternal.add(r);
    }
  }

  return {
    externalReferencers,
    hasExternalReferencers: externalReferencers.size > 0,
    externalReferencerCount: distinctExternal.size,
  };
}
