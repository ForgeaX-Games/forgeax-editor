// openProject(pointer, reader) — editor-core authoring entry point (M3 w14).
//
// Opens a game project identified by `pointer`, using the injected `reader`
// for all file I/O. The reader receives project-relative paths (e.g.
// 'forge.json', 'scenes/main.pack.json') and returns the file content as a
// UTF-8 string.
//
// Flow:
//   1. loadGameProject(reader) → typed forge.json
//   2. If defaultScene is set, resolve the scene asset from its pack via the
//      reader, register it into a fresh World, and instantiate.
//   3. If defaultScene is absent → graceful skip (world exists, sceneRoot=null,
//      no throw).
//
// Charter mapping:
//   P4 (consistent abstraction): single reader injection hides all I/O —
//     AI users pass one loader and don't care whether it's fetch, fs, or mock.
//   P3 (explicit failure): returns a structured result with a `status`
//     discriminant ('opened' | 'no-scene' | 'load-failed' | 'scene-missing')
//     so a load failure is distinguishable from a successful open with no
//     default scene — both yield sceneRoot=null, which alone is ambiguous.
//     Never a silent internal fallback.
//
// Anchors:
//   plan-tasks.json w14: openProject(pointer, reader) contract implementation
//   requirements AC-06: editor world has defaultScene projection after openProject
//   requirements edge-case: project without defaultScene skips instantiate gracefully
//   plan-strategy D-10: reader injected into loadGameProject + resolveDefaultScene
//   OOS-4: fetch reader only, fs/FSA reader deferred (not implemented)

import { World } from '@forgeax/engine-ecs';
import type { SceneAsset } from '@forgeax/engine-types';
import { loadGameProject } from '@forgeax/engine-project';

/**
 * A forgeax engine World returned by openProject.
 *
 * Use InstanceType<typeof World> to avoid TS2709 when the module shim
 * (declare module) creates an ambient namespace conflict with the real
 * class export.
 */
export type OpenProjectWorld = InstanceType<typeof World>;

/**
 * Discriminant for an openProject outcome — lets an AI user / caller tell a
 * genuine failure apart from a successful open that legitimately has no scene
 * to project (charter P3: explicit failure surface, not a silent null).
 *
 *   'opened'        — project loaded; a defaultScene was resolved and
 *                     instantiated (sceneRoot is a real entity).
 *   'no-scene'      — project loaded fine but has no defaultScene to project
 *                     (sceneRoot is null; this is NOT an error).
 *   'load-failed'   — forge.json could not be loaded/validated (sceneRoot null).
 *   'scene-missing' — defaultScene is set but its pack/asset could not be read,
 *                     parsed, or instantiated (sceneRoot null).
 */
export type OpenProjectStatus =
  | 'opened'
  | 'no-scene'
  | 'load-failed'
  | 'scene-missing';

/** Outcome of an openProject call. */
export interface OpenProjectResult {
  readonly world: OpenProjectWorld;
  readonly sceneRoot: number | null;
  /**
   * Discriminant distinguishing a load failure from a successful open with no
   * default scene. `sceneRoot` alone cannot express this — both legitimately
   * yield null. Callers branch on `status`; `ok` is a convenience derived flag
   * (true unless the open failed outright).
   */
  readonly status: OpenProjectStatus;
  /** Convenience flag: false only for 'load-failed' / 'scene-missing'. */
  readonly ok: boolean;
}

/**
 * Open a game project and project its defaultScene (if any) into a fresh World.
 *
 * @param pointer - Project identifier (slug).
 * @param reader - Project-relative file reader.
 */
export async function openProject(
  pointer: string,
  reader: (path: string) => Promise<string>,
): Promise<OpenProjectResult> {
  const world = new World();

  // 1. Load forge.json via the authoritative engine-project loader.
  const gpResult = await loadGameProject(reader);
  if (!gpResult.ok) {
    // forge.json missing/invalid — a genuine failure, distinct from no-scene.
    return { world, sceneRoot: null, status: 'load-failed', ok: false };
  }

  const gp = gpResult.value;

  // 2. No defaultScene → graceful skip (charter P3: explicit status, not throw).
  if (!gp.defaultScene) {
    return { world, sceneRoot: null, status: 'no-scene', ok: true };
  }

  const defaultSceneGuid = gp.defaultScene as string;

  // 3. Read the conventional scene pack.
  // defaultScene was declared but cannot be projected below → 'scene-missing'
  // (a failure, distinct from 'no-scene' where no scene was ever declared).
  let packRaw: string;
  try {
    packRaw = await reader(`scenes/main.pack.json`);
  } catch {
    return { world, sceneRoot: null, status: 'scene-missing', ok: false };
  }

  // 4. Parse the pack and locate the asset entry.
  let pack: { assets?: Array<{ guid: string; kind: string; payload: unknown }> };
  try {
    pack = JSON.parse(packRaw);
  } catch {
    return { world, sceneRoot: null, status: 'scene-missing', ok: false };
  }

  const assets = pack.assets;
  if (!assets || !Array.isArray(assets)) {
    return { world, sceneRoot: null, status: 'scene-missing', ok: false };
  }

  const entry = assets.find(
    (a): a is { guid: string; kind: string; payload: SceneAsset } =>
      a.guid === defaultSceneGuid && a.kind === 'scene' && typeof a.payload === 'object' && a.payload !== null,
  );
  if (!entry) {
    return { world, sceneRoot: null, status: 'scene-missing', ok: false };
  }

  // 5. Register the SceneAsset and instantiate into the World.
  const sceneAsset: SceneAsset = entry.payload as SceneAsset;
  const handle = world.allocSharedRef('SceneAsset', sceneAsset);
  const res = world.instantiateScene(handle);
  if (!res.ok) {
    return { world, sceneRoot: null, status: 'scene-missing', ok: false };
  }

  const raw = res.value as unknown;
  const root: number =
    typeof raw === 'number' ? raw : (raw as { root: number }).root;

  return { world, sceneRoot: root, status: 'opened', ok: true };
}