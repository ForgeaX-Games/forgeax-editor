// session/animation-preview — preview snapshot/restore registry (M1)
//
// Save-pollution defense for animation previews. Preview ops
// (setAnimationPreview) and per-frame playback mutate fields that are NOT
// authored intent (AnimationPlayer.times/speeds/paused per the reflected
// playback contract's runtimeFields). Without a defense those live values
// would be serialized verbatim into the pack on save (P0-verified: the engine
// collector only skips component/field-level `transient` declarations, and
// these fields are not declared transient).
//
// Mechanism: the FIRST preview write on an entity snapshots the
// reflection-declared runtimeFields (typed arrays copied); the
// save/play/selection-change/scene-switch boundaries restore them through the
// same engine write face, so saved bytes match the pre-preview authored state.
//
// Field classification is data-driven — schema.animation.runtimeFields (engine
// meta.animation long-term SSOT; editor overlay interim), never a hardcoded
// field list here.

import { resolveComponent } from '@forgeax/engine-ecs';
import type { SessionApplierCtx } from '../io/appliers';
import { getComponentSchema } from '../scene/schema';

/** The engine write face a session applier receives (facade proxy). */
export type AnimationPreviewEngine = NonNullable<SessionApplierCtx['engine']>;

interface PreviewSnapshot {
  readonly component: string;
  readonly data: Record<string, unknown>;
}

/** entity handle → pre-preview authored runtime-field values. */
const _snapshots = new Map<number, PreviewSnapshot>();

function copyFieldValue(value: unknown): unknown {
  // Typed arrays (Float32Array times/speeds/…) carry a .slice copy; DataView is
  // not a component field value in practice and would fall to the scalar path.
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return (value as Float32Array).slice();
  if (Array.isArray(value)) return [...value];
  return value;
}

/** Snapshot the reflection-declared runtimeFields for `entity` if not already
 *  snapshotted. First-write-wins: the stored values are the authored baseline
 *  every boundary restores. Returns false when nothing was snapshot (component
 *  absent, contract missing, or already snapshotted). */
export function snapshotAnimationPreview(
  engine: AnimationPreviewEngine,
  entity: number,
  component = 'AnimationPlayer',
): boolean {
  if (_snapshots.has(entity)) return false;
  const runtimeFields = getComponentSchema(component)?.animation?.runtimeFields;
  if (runtimeFields === undefined || runtimeFields.length === 0) return false;
  const token = resolveComponent(component);
  if (token === undefined) return false;
  const cur = engine.get(entity, token) as { ok: boolean; value?: Record<string, unknown> };
  if (!cur.ok || cur.value === undefined) return false;
  const data: Record<string, unknown> = {};
  for (const field of runtimeFields) {
    if (cur.value[field] !== undefined) data[field] = copyFieldValue(cur.value[field]);
  }
  _snapshots.set(entity, { component, data });
  return true;
}

/** Restore one entity's snapshotted runtime fields through the engine write
 *  face and drop the snapshot. Fresh copies are written so the world never
 *  aliases the stored snapshot (a later preview can't mutate the baseline). */
export function restoreAnimationPreview(engine: AnimationPreviewEngine, entity: number): boolean {
  const snap = _snapshots.get(entity);
  if (snap === undefined) return false;
  _snapshots.delete(entity);
  const token = resolveComponent(snap.component);
  if (token === undefined) return false;
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snap.data)) data[key] = copyFieldValue(value);
  const r = engine.set(entity, token, data) as { ok?: boolean } | undefined;
  if (r !== undefined && r.ok === false) {
    console.warn(`[editor-core] animation-preview: restore failed for entity ${entity} (${snap.component})`);
    return false;
  }
  return true;
}

/** Restore every snapshotted entity (save / play boundary). Returns the number
 *  of entities restored. */
export function restoreAllAnimationPreviews(engine: AnimationPreviewEngine): number {
  let restored = 0;
  for (const entity of [..._snapshots.keys()]) {
    if (restoreAnimationPreview(engine, entity)) restored++;
  }
  return restored;
}

/** Restore previews for every entity NOT in `keep` (selection-change boundary:
 *  leaving the Inspector's focus ends the preview session for that entity). */
export function restoreAnimationPreviewsOutside(
  engine: AnimationPreviewEngine,
  keep: ReadonlySet<number>,
): number {
  let restored = 0;
  for (const entity of [..._snapshots.keys()]) {
    if (keep.has(entity)) continue;
    if (restoreAnimationPreview(engine, entity)) restored++;
  }
  return restored;
}

/** Drop all snapshots WITHOUT restoring (scene teardown — the entities are
 *  about to be despawned, so restore would write into a dying world). */
export function clearAnimationPreviews(): void {
  _snapshots.clear();
}

export function hasAnimationPreview(entity: number): boolean {
  return _snapshots.has(entity);
}

export function previewedAnimationEntities(): readonly number[] {
  return [..._snapshots.keys()];
}
