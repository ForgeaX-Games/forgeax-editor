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
// Trimmed from packages/engine/templates/game-default (no shooting / HUD /
// physics props) to stay a *simple* sample. Every mesh the scene references is an
// engine builtin (cube / sphere), pre-catalogued by GUID -- no runtime catalog
// step, no __import round-trip.

import {
  Transform, Camera, perspective, quat,
  SceneInstance,
  TONEMAP_REINHARD_EXTENDED, ANTIALIAS_FXAA,
} from '@forgeax/engine-runtime';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { BootstrapContext } from '@forgeax/engine-app';
import type { SceneAsset } from '@forgeax/engine-types';

// The scene's GUID (assets/scene.pack.json assets[0].guid; also forge.json
// defaultScene). loadByGuid<SceneAsset>(this) pulls the scene AND recursively its
// refs[] (the material siblings) from the pluginPack pack-index.
const SCENE_GUID = '2b7c9a10-4d5e-5f60-8a1b-2c3d4e5f6071';

type Ctx = { world: World; assets?: import('@forgeax/engine-assets-runtime').AssetRegistry };

interface PackNode { localId: number; components: Record<string, Record<string, unknown>> }

// Load the authored scene the canonical way -> return the localId->Entity mapping
// (so the caller can find the Player) + the nodes. Returns null on any failure
// (caller falls back to no player, camera-only).
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
  const { registerUpdate } = ctx ?? {};

  const canvas = document.querySelector<HTMLCanvasElement>('#app')!;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  const aspect = canvas.width / canvas.height || 1;

  // ── load the authored scene (the SAME native asset ✎ Edit writes) ────────────
  let loaded: { mapping: ReadonlyMap<number, EntityHandle>; nodes: PackNode[] } | null = null;
  try {
    loaded = await loadScene({ world, assets: ctx?.assets });
  } catch (err) {
    console.warn('[game] scene asset unavailable:', err);
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

  // ── camera: a high tilted follow cam (top-down 2.5D) ─────────────────────────
  const TOP_DY = 12, TOP_DZ = 9;
  const CAM_FOLLOW = 8;
  const topPitch = -Math.atan2(TOP_DY, TOP_DZ);
  const topQ = quat.create();
  quat.fromAxisAngle(topQ, [1, 0, 0], topPitch);
  let camX = initX, camZ = initZ + TOP_DZ;
  const camera = world.spawn(
    { component: Transform, data: { pos: [camX, TOP_DY, camZ], quat: [topQ[0]!, topQ[1]!, topQ[2]!, topQ[3]!] } },
    { component: Camera, data: { ...perspective({ fov: Math.PI / 3, aspect, near: 0.1, far: 200 }), tonemap: TONEMAP_REINHARD_EXTENDED, antialias: ANTIALIAS_FXAA, clearR: 0.4, clearG: 0.6, clearB: 1.0 } },
  ).unwrap();

  // ── input: WASD / arrows move the Player on the ground plane ──────────────────
  const keys: Record<string, boolean> = {};
  window.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });

  const SPEED = 6;      // walk speed (units/s)
  const BOUND = 9;      // keep the player on the ground slab
  let px = initX, pz = initZ;

  if (registerUpdate) {
    registerUpdate((dt: number) => {
      const f = ((keys['KeyW'] || keys['ArrowUp']) ? 1 : 0) - ((keys['KeyS'] || keys['ArrowDown']) ? 1 : 0);
      const s = ((keys['KeyD'] || keys['ArrowRight']) ? 1 : 0) - ((keys['KeyA'] || keys['ArrowLeft']) ? 1 : 0);
      // top-down world-relative: W -> -Z, D -> +X
      let mvx = s, mvz = -f;
      if (mvx !== 0 || mvz !== 0) {
        const l = Math.hypot(mvx, mvz) || 1;
        const step = SPEED * dt;
        px = Math.max(-BOUND, Math.min(BOUND, px + (mvx / l) * step));
        pz = Math.max(-BOUND, Math.min(BOUND, pz + (mvz / l) * step));
        if (player !== undefined) {
          const cur = world.get(player, Transform);
          const py = cur.ok ? (cur.value.pos[1] ?? 0.75) : 0.75;
          world.set(player, Transform, { pos: [px, py, pz] });
        }
      }

      // follow camera
      const a = 1 - Math.exp(-CAM_FOLLOW * dt);
      camX += (px - camX) * a;
      camZ += (pz + TOP_DZ - camZ) * a;
      world.set(camera, Transform, { pos: [camX, TOP_DY, camZ], quat: [topQ[0]!, topQ[1]!, topQ[2]!, topQ[3]!] });
    });
  }
}
