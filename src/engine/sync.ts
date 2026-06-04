// Engine sync — projects the authored SceneDocument onto a real forgeax world so
// what you edit renders with the SAME engine the game plays on (WYSIWYG). This
// is the bridge between the (engine-agnostic) command-bus data model ported from
// the unveil-studio prototype and forgeax's WebGPU renderer.
//
// P1 strategy: full rebuild on every doc change. The editor scene is small, and
// a rebuild keeps the mapping trivially correct (no per-field diffing). Each doc
// entity that carries a Transform becomes a forgeax cube at that position, tinted
// by its Material.albedo when a base material is available. Entities without a
// Transform (e.g. a "Level"/"Group" node) or marked hidden are skipped — they're
// organizational, not renderable. Edit mode is intentionally STATIC (no Spin/
// Velocity simulation): in forgeax, ▶ Play runs the real game; ✎ Edit authors it.
import {
  Transform,
  MeshFilter,
  MeshRenderer,
  HANDLE_CUBE,
} from '@forgeax/engine-runtime';
import type { EntityId } from '../core/types';
import { bus } from '../store';

// Minimal structural types for the slice of the forgeax world/renderer we use —
// avoids leaking the engine's full (currently untyped) surface into this module
// and keeps it testable. An opaque material handle is whatever register/loadByGuid
// returns; we only ever pass it back to register({ parent }).
type MaterialHandle = unknown;
interface WorldLike {
  spawn(...componentDatas: unknown[]): { ok: boolean; value?: number; unwrap(): number };
  despawn(entity: number): unknown;
}
interface RendererLike {
  assets: {
    register(desc: unknown): { unwrap(): MaterialHandle };
  };
}

/** 6-digit hex (#rrggbb) → linear-ish [r,g,b,1] in 0..1 (good enough for tint). */
function hexToRgba(hex: string): [number, number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0.8, 0.8, 0.8, 1];
  const n = parseInt(m[1]!, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
}

export interface EngineSync {
  /** Rebuild the rendered world from the current doc. Called on every bus change. */
  resync(): void;
  /** Stop listening to the bus. */
  dispose(): void;
}

/**
 * Wire the bus to a forgeax world. `baseMaterial` (optional) is the parent
 * material whose `baseColor` param we override per entity to apply the editor's
 * Material.albedo; when null (e.g. empty pack-index in P0) cubes render with the
 * engine's default material and albedo tint is a no-op (graceful degrade).
 */
export function createEngineSync(
  world: WorldLike,
  renderer: RendererLike,
  baseMaterial: MaterialHandle | null,
): EngineSync {
  // doc entity id → spawned forgeax entity (so a rebuild can despawn the old set).
  const spawned = new Map<EntityId, number>();

  function clear(): void {
    for (const ent of spawned.values()) {
      try { world.despawn(ent); } catch { /* already retired — ignore */ }
    }
    spawned.clear();
  }

  function resync(): void {
    clear();
    const doc = bus.doc;
    for (const id of doc.order) {
      const node = doc.entities[id];
      if (!node || node.hidden) continue;
      const t = node.components.Transform as { x?: number; y?: number; z?: number } | undefined;
      if (!t) continue; // organizational node (no transform → nothing to draw)

      // Material: register a child of the base material with this entity's albedo
      // tint. Without a base material we fall back to the engine default (no tint).
      let renderData: Record<string, unknown> = {};
      const mat = node.components.Material as { albedo?: unknown } | undefined;
      if (baseMaterial) {
        const albedo = typeof mat?.albedo === 'string' ? mat.albedo : '#cccccc';
        try {
          const handle = renderer.assets
            .register({ kind: 'material', parent: baseMaterial, paramValues: { baseColor: hexToRgba(albedo) } })
            .unwrap();
          renderData = { material: handle };
        } catch {
          renderData = {};
        }
      }

      const r = world.spawn(
        { component: Transform, data: { posX: Number(t.x ?? 0), posY: Number(t.y ?? 0), posZ: Number(t.z ?? 0) } },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: renderData },
      );
      if (r.ok && r.value !== undefined) spawned.set(id, r.value);
    }
  }

  const unsub = bus.subscribe(() => resync());
  resync();

  return {
    resync,
    dispose() {
      unsub();
      clear();
    },
  };
}
