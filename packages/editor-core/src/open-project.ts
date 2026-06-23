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
//   P3 (explicit failure): returns structured result — null sceneRoot for
//     no-defaultScene, never silent internal fallback.
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

/** Outcome of a successful openProject call. */
export interface OpenProjectResult {
  readonly world: OpenProjectWorld;
  readonly sceneRoot: number | null;
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
    return { world, sceneRoot: null };
  }

  const gp = gpResult.value;

  // 2. No defaultScene → graceful skip (charter P3: explicit null, not throw).
  if (!gp.defaultScene) {
    return { world, sceneRoot: null };
  }

  const defaultSceneGuid = gp.defaultScene as string;

  // 3. Read the conventional scene pack.
  let packRaw: string;
  try {
    packRaw = await reader(`scenes/main.pack.json`);
  } catch {
    return { world, sceneRoot: null };
  }

  // 4. Parse the pack and locate the asset entry.
  let pack: { assets?: Array<{ guid: string; kind: string; payload: unknown }> };
  try {
    pack = JSON.parse(packRaw);
  } catch {
    return { world, sceneRoot: null };
  }

  const assets = pack.assets;
  if (!assets || !Array.isArray(assets)) {
    return { world, sceneRoot: null };
  }

  const entry = assets.find(
    (a): a is { guid: string; kind: string; payload: SceneAsset } =>
      a.guid === defaultSceneGuid && a.kind === 'scene' && typeof a.payload === 'object' && a.payload !== null,
  );
  if (!entry) {
    return { world, sceneRoot: null };
  }

  // 5. Register the SceneAsset and instantiate into the World.
  const sceneAsset: SceneAsset = entry.payload as SceneAsset;
  const handle = world.allocSharedRef('SceneAsset', sceneAsset);
  const res = world.instantiateScene(handle);
  if (!res.ok) {
    return { world, sceneRoot: null };
  }

  const raw = res.value as unknown;
  const root: number =
    typeof raw === 'number' ? raw : (raw as { root: number }).root;

  return { world, sceneRoot: root };
}