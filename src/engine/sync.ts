// Engine sync — projects the authored SceneDocument onto a real forgeax world so
// what you edit renders with the SAME engine the game plays on (WYSIWYG).
//
// The doc→world mapping itself lives in @forgeax/scene's `instantiateScene` — the
// SAME function games call in ▶ Play. This module just owns the editor-side
// lifecycle: full rebuild on every bus change (the editor scene is small, so a
// rebuild keeps the mapping trivially correct — no per-field diffing), despawning
// the previous set first. Edit mode is intentionally STATIC (no Spin/Velocity
// simulation): in forgeax, ▶ Play runs the real game; ✎ Edit authors it.
import { instantiateScene } from '@forgeax/scene';
import type { EntityId } from '../core/types';
import { bus } from '../store';

// Minimal structural types for the slice of the forgeax world/renderer we use.
interface WorldLike {
  spawn(...componentDatas: unknown[]): { ok: boolean; value?: number; unwrap(): number };
  despawn(entity: number): unknown;
}
interface RendererLike {
  assets: { register(desc: unknown): { unwrap(): unknown } };
}

export interface EngineSync {
  /** Rebuild the rendered world from the current doc. Called on every bus change. */
  resync(): void;
  /** The live forgeax entity rendering doc entity `id`, if any. Lets the viewport
   *  move an entity directly (world.set) during a drag — a live preview that
   *  bypasses the doc + a full resync, committed as one command on release. */
  worldEntityFor(id: EntityId): number | undefined;
  /** Stop listening to the bus. */
  dispose(): void;
}

/**
 * Wire the bus to a forgeax world. Each doc change despawns the previous render
 * set and re-instantiates the document via @forgeax/scene (geometry, PBR/unlit
 * materials, emissive, lights — full fidelity with ▶ Play).
 */
export function createEngineSync(
  world: WorldLike,
  renderer: RendererLike,
  resolveMaterialAsset?: (guid: string) => unknown | null,
): EngineSync {
  // doc entity id → live forgeax entity (kept so a rebuild can despawn the old
  // set, and so the viewport can move a single entity live during a drag).
  let byDoc = new Map<EntityId, number>();

  function clear(): void {
    for (const ent of byDoc.values()) {
      try { world.despawn(ent); } catch { /* already retired — ignore */ }
    }
    byDoc = new Map();
  }

  function resync(): void {
    clear();
    const { entities } = instantiateScene(bus.doc, {
      world: world as never,
      assets: renderer.assets as never,
      resolveMaterialAsset,
    });
    byDoc = entities as Map<EntityId, number>;
  }

  const unsub = bus.subscribe(() => resync());
  resync();

  return {
    resync,
    worldEntityFor: (id) => byDoc.get(id),
    dispose() {
      unsub();
      clear();
    },
  };
}
