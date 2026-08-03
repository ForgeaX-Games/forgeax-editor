// Simple sample game -- a builtin-mesh vignette + a WASD-movable Player.
//
// The STATIC scene (ground, sun, props, the Player's INITIAL position) is an
// engine-native scene ASSET: `assets/scene.pack.json` (one `kind:'scene'` asset
// + `kind:'material'` siblings, GUID-discoverable via `forge.json.defaultScene`).
// main.ts loads it the SAME canonical way every engine app does --
// `loadByGuid<SceneAsset>` -> `allocSharedRef` -> `assets.instantiate` -- so what
// you arrange in the editor's ✎ Edit is exactly what runs here in ▶ Play. This
// file adds only the DYNAMIC layer: a follow camera + WASD movement on "Player".
//
// Scene-load is ASSET-FIRST (mirrors packages/engine/templates/game-default): the
// host (editor ▶ Play / preview) resolves + instantiates forge.json.defaultScene
// BEFORE bootstrap runs and hands us the instance via ctx.defaultSceneRoot; we
// ADOPT it instead of re-instantiating (re-instantiating loads the scene TWICE →
// duplicate camera / sun → render-system-multi-camera / -multi-light). Only a
// standalone module with no host pre-load falls back to loadByGuid ourselves.
//
// Trimmed from packages/engine/templates/game-default (no shooting / HUD /
// physics props) to stay a *simple* sample. Every mesh the scene references is an
// engine builtin (cube / sphere), pre-catalogued by GUID -- no runtime catalog
// step, no __import round-trip.

import { quat } from '@forgeax/engine-math';
import { Camera, perspective, TONEMAP_REINHARD_EXTENDED, ANTIALIAS_FXAA, SceneInstance } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { defineSystem, Time, Update, type EntityHandle, type World } from '@forgeax/engine-ecs';
import {
  FRAME_START_SCAN_SYSTEM_NAME,
  INPUT_SNAPSHOT_RESOURCE_KEY,
  type InputSnapshot,
} from '@forgeax/engine-input';
import type { BootstrapContext } from '@forgeax/engine-app';
import type { SceneAsset } from '@forgeax/engine-types';

// The scene's GUID (assets/scene.pack.json assets[0].guid; also forge.json
// defaultScene). loadByGuid<SceneAsset>(this) pulls the scene AND recursively its
// refs[] (the material siblings) from the pluginPack pack-index.
const SCENE_GUID = '2b7c9a10-4d5e-5f60-8a1b-2c3d4e5f6071';

type Ctx = { world: World; assets?: import('@forgeax/engine-assets-runtime').AssetRegistry };

interface PackNode { localId: number; components: Record<string, Record<string, unknown>> }

const SAMPLE_PLAYER_ENTITY_KEY = 'sample-player-entity';
const SAMPLE_PLAYER_INPUT_SYSTEM_NAME = 'sample-player-input';

// Play-only gameplay logic consumes the engine's frozen frame-start snapshot.
// The editor host injects the browser backend into the Play world, and
// inputPlugin() schedules its scan before this system. No DOM listener is
// allowed here: the same engine input contract must work in browser and CI.
const samplePlayerInput = defineSystem({
  name: SAMPLE_PLAYER_INPUT_SYSTEM_NAME,
  queries: [],
  after: [FRAME_START_SCAN_SYSTEM_NAME],
  fn: (world) => {
    if (!world.hasResource(SAMPLE_PLAYER_ENTITY_KEY) || !world.hasResource(INPUT_SNAPSHOT_RESOURCE_KEY)) return;
    const player = world.getResource<EntityHandle>(SAMPLE_PLAYER_ENTITY_KEY);
    const snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
    const forward = snap.keyboard.down('w') || snap.keyboard.down('W') || snap.keyboard.down('ArrowUp');
    const back = snap.keyboard.down('s') || snap.keyboard.down('S') || snap.keyboard.down('ArrowDown');
    const left = snap.keyboard.down('a') || snap.keyboard.down('A') || snap.keyboard.down('ArrowLeft');
    const right = snap.keyboard.down('d') || snap.keyboard.down('D') || snap.keyboard.down('ArrowRight');
    const mvx = (right ? 1 : 0) - (left ? 1 : 0);
    const mvz = (back ? 1 : 0) - (forward ? 1 : 0);
    if (mvx === 0 && mvz === 0) return;

    const current = world.get(player, Transform);
    if (!current.ok) return;
    const length = Math.hypot(mvx, mvz) || 1;
    const step = 6 * world.getResource(Time).delta;
    const px = Math.max(-9, Math.min(9, (current.value.pos[0] ?? 0) + (mvx / length) * step));
    const py = current.value.pos[1] ?? 0.75;
    const pz = Math.max(-9, Math.min(9, (current.value.pos[2] ?? 0) + (mvz / length) * step));
    world.set(player, Transform, { pos: [px, py, pz] });
  },
});

// Load the authored scene the canonical way -> return the localId->Entity mapping
// (so the caller can find the Player) + the nodes. Returns null on any failure
// (caller falls back to no player, camera-only). Only used when the host did NOT
// pre-instantiate the scene (standalone module path).
async function loadScene(
  ctx: Ctx,
): Promise<{ mapping: ReadonlyMap<number, EntityHandle>; nodes: PackNode[] } | null> {
  const { world, assets } = ctx;
  if (!assets) return null;
  const sceneGuid = AssetGuid.parse(SCENE_GUID);
  if (!sceneGuid.ok) return null;
  const loadRes = await assets.loadByGuid<SceneAsset>(sceneGuid.value);
  if (!loadRes.ok) { console.error('[game] scene loadByGuid failed:', loadRes.error); return null; }
  const sceneHandle = world.allocSharedRef('SceneAsset', loadRes.value);
  const instRes = assets.instantiate<SceneAsset>(sceneHandle, world);
  if (!instRes.ok) { console.error('[game] scene instantiate failed:', (instRes.error as { code?: string })?.code); return null; }
  const root = instRes.value;
  const sceneInst = world.get(root, SceneInstance);
  if (!sceneInst.ok) { console.error('[game] SceneInstance lookup failed:', sceneInst.error); return null; }
  const mappingArr = sceneInst.value.mapping;
  const nodes = loadRes.value.entities as unknown as PackNode[];
  const mapping = new Map<number, EntityHandle>();
  for (const n of nodes) {
    const e = mappingArr[n.localId];
    if (e !== undefined) mapping.set(n.localId, e as EntityHandle);
  }
  return { mapping, nodes };
}

export async function bootstrap(world: World, ctx?: BootstrapContext) {
  const canvas = document.querySelector<HTMLCanvasElement>('#app')!;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  const aspect = canvas.width / canvas.height || 1;

  // ── load the authored scene (the SAME native asset ✎ Edit writes) ────────────
  let loaded: { mapping: ReadonlyMap<number, EntityHandle>; nodes: PackNode[] } | null = null;

  // Asset-first host (editor ▶ Play / preview): the host resolves + instantiates
  // forge.json.defaultScene BEFORE bootstrap runs and hands us the synthetic root
  // via ctx.defaultSceneRoot (+ the loaded SceneAsset via ctx.defaultScene). ADOPT
  // that instance — re-instantiating here would load the scene TWICE (host copy +
  // our copy), duplicating the sun (render-system-multi-light) and, once a camera
  // is added, the camera. Recover { mapping, nodes } from the SceneInstance on the
  // host root (localId->Entity) + the author-side entity list (carries Name).
  const hostRoot = ctx?.defaultSceneRoot;
  if (hostRoot !== undefined && ctx?.defaultScene !== undefined) {
    const sceneInst = world.get(hostRoot, SceneInstance);
    if (!sceneInst.ok) {
      console.error('[game] SceneInstance lookup on host root failed:', sceneInst.error);
    } else {
      // mapping is a Uint32Array sized maxLocalId+1, indexed by localId; skip
      // unspawned slots (ENTITY_NULL_RAW = 0xffffffff) and 0.
      const mappingArr = sceneInst.value.mapping as unknown as { length: number; [i: number]: number };
      const mapping = new Map<number, EntityHandle>();
      for (let localId = 0; localId < mappingArr.length; localId++) {
        const e = mappingArr[localId];
        if (e !== undefined && e !== 0xffffffff && e !== 0) mapping.set(localId, e as EntityHandle);
      }
      loaded = { mapping, nodes: ctx.defaultScene.entities as unknown as PackNode[] };
    }
  }

  // Fallback: no host-instantiated scene (standalone game module, or the host has
  // no defaultScene) — load it ourselves the canonical loadByGuid -> instantiate path.
  if (!loaded) {
    try {
      loaded = await loadScene({ world, assets: ctx?.assets });
    } catch (err) {
      console.warn('[game] scene asset unavailable:', err);
    }
  }

  // Player + its initial XZ (from the authored "Player" node).
  let player: EntityHandle | undefined;
  let initX = 0, initZ = 0;
  if (loaded) {
    const playerNode = loaded.nodes.find((n) => (n.components.Name as { value?: string } | undefined)?.value === 'Player');
    if (playerNode) {
      const t = (playerNode.components.Transform ?? {}) as { pos?: number[] };
      initX = t.pos?.[0] ?? 0; initZ = t.pos?.[2] ?? 0;
      player = loaded.mapping.get(playerNode.localId);
    }
  }
  if (player !== undefined) {
    world.insertResource(SAMPLE_PLAYER_ENTITY_KEY, player);
    world.addSystem(Update, samplePlayerInput).unwrap();
  }

  // ── camera: a high tilted follow cam (top-down 2.5D) ─────────────────────────
  // An authored scene Camera is the user's visual intent. Reuse it in Play so
  // the sample game does not introduce a second camera behind the editor's
  // back. The follow camera remains the standalone/no-authored-camera default.
  const authoredCameraNode = loaded?.nodes.find((n) => n.components.Camera !== undefined);
  const authoredCamera = authoredCameraNode === undefined
    ? undefined
    : loaded?.mapping.get(authoredCameraNode.localId);
  // The camera is spawned in code (same as templates/game-default): ▶ Play forks a
  // fresh play world whose only camera is this one when the scene has no authored
  // camera. clearColor = visible sky (the sample scene has no SkyboxBackground
  // entity, so this quartet IS the background; the engine's Camera stores it as
  // an `array<f32,4>` field named `clearColor`).
  const TOP_DY = 12, TOP_DZ = 9;
  const CAM_FOLLOW = 8;
  const topPitch = -Math.atan2(TOP_DY, TOP_DZ);
  const topQ = quat.create();
  quat.fromAxisAngle(topQ, [1, 0, 0], topPitch);
  let camX = initX, camZ = initZ + TOP_DZ;
  const camera = authoredCamera ?? world.spawn(
    { component: Transform, data: { pos: [camX, TOP_DY, camZ], quat: [topQ[0]!, topQ[1]!, topQ[2]!, topQ[3]!] } },
    { component: Camera, data: { ...perspective({ fov: Math.PI / 3, aspect, near: 0.1, far: 200 }), tonemap: TONEMAP_REINHARD_EXTENDED, antialias: ANTIALIAS_FXAA, clearColor: [0.4, 0.6, 1.0, 1] } },
  ).unwrap();

  // ── camera follow: movement itself is the module-level Play system above ──────
  let px = initX, pz = initZ;
  world.addSystem(Update, {
    name: 'sample-follow-camera',
    queries: [],
    after: [SAMPLE_PLAYER_INPUT_SYSTEM_NAME],
    fn: () => {
      if (player !== undefined) {
        const current = world.get(player, Transform);
        if (current.ok) {
          px = current.value.pos[0] ?? px;
          pz = current.value.pos[2] ?? pz;
        }
      }

      // Follow only the game-owned fallback camera. Authored cameras keep the
      // exact scene transform and projection through the Edit → Play roundtrip.
      if (authoredCamera === undefined) {
        const dt = world.getResource(Time).delta;
        const a = 1 - Math.exp(-CAM_FOLLOW * dt);
        camX += (px - camX) * a;
        camZ += (pz + TOP_DZ - camZ) * a;
        world.set(camera, Transform, { pos: [camX, TOP_DY, camZ], quat: [topQ[0]!, topQ[1]!, topQ[2]!, topQ[3]!] });
      }
    },
  }).unwrap();
}
