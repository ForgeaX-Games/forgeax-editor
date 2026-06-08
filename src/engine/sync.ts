// Engine sync — projects the authored SceneDocument onto a real forgeax world so
// what you edit renders with the SAME engine the game plays on (WYSIWYG).
//
// The doc→world mapping itself lives in @forgeax/scene's `instantiateScene` — the
// SAME function games call in ▶ Play. This module just owns the editor-side
// lifecycle: full rebuild on every bus change (the editor scene is small, so a
// rebuild keeps the mapping trivially correct — no per-field diffing), despawning
// the previous set first. Edit mode is intentionally STATIC (no Spin/Velocity
// simulation): in forgeax, ▶ Play runs the real game; ✎ Edit authors it.
import { instantiateScene, loadGltfRuntime, isGltfLoaded } from '@forgeax/scene';
import type { EntityId } from '../core/types';
import { bus } from '../store';

// Fetch a project file's raw bytes (binary) via the server. Used to feed the
// runtime glTF loader so GltfRef entities render their REAL geometry, not just
// the placeholder cube instantiateScene falls back to.
async function fetchProjectBytes(path: string): Promise<ArrayBuffer> {
  const r = await fetch(`/api/files/raw?path=${encodeURIComponent(path)}`);
  if (!r.ok) throw new Error(`fetch ${path} → HTTP ${r.status}`);
  return r.arrayBuffer();
}

// Collect every GltfRef path referenced by the doc (so we can preload them).
function gltfRefPaths(doc: { entities: Record<number, { components?: Record<string, unknown> }> }): string[] {
  const out = new Set<string>();
  for (const e of Object.values(doc.entities)) {
    const g = e.components?.GltfRef as { path?: string } | undefined;
    if (g?.path) out.add(g.path);
  }
  return [...out];
}

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
  // doc entity id → a representative live forgeax entity (so the viewport can
  // move a single entity live during a drag). NOT the teardown set — a GltfRef
  // expands to thousands of world entities but only its first lands here.
  let byDoc = new Map<EntityId, number>();
  // EVERY live forgeax entity from the last build — the actual teardown set.
  // Despawning only byDoc would orphan a GltfRef's extra entities, so each
  // rebuild would stack a duplicate copy on top (overlapping geometry → the
  // "scene flickers" bug). Despawn all of these instead.
  let spawned: number[] = [];
  // GltfRef paths whose async load has been started (one load + one resync each).
  const kicked = new Set<string>();
  // Signature of the last rendered state (doc content + which GLBs are loaded).
  // resync() is wired to bus.subscribe, which can fire spuriously (snapshot /
  // selection sync echoes etc.); rebuilding the whole world on an UNCHANGED doc
  // is what makes a heavy scene flicker. Skipping no-op rebuilds kills that.
  let lastSig: string | null = null;

  function clear(): void {
    for (const ent of spawned) {
      try { world.despawn(ent); } catch { /* already retired — ignore */ }
    }
    spawned = [];
    byDoc = new Map();
  }

  function resync(): void {
    const paths = gltfRefPaths(bus.doc as never);
    // Skip the rebuild when nothing rendered has changed (doc content + which
    // GLBs are loaded). The doc itself is tiny — a GltfRef expands to thousands
    // of WORLD entities but stays ONE doc entity — so this signature is cheap.
    const sig = JSON.stringify(bus.doc) + '#' + paths.map((p) => (isGltfLoaded(p) ? '1' : '0')).join('');
    if (sig === lastSig) return;
    lastSig = sig;

    clear();
    const { entities, all } = instantiateScene(bus.doc, {
      world: world as never,
      assets: renderer.assets as never,
      resolveMaterialAsset,
    });
    byDoc = entities as Map<EntityId, number>;
    spawned = all as number[];
    // Kick off async loading of any GltfRef GLB not yet parsed; when one lands,
    // its isGltfLoaded flips → the signature changes → resync rebuilds ONCE,
    // swapping the placeholder for real geometry. `kicked` ensures one load per
    // path (no stacked .then(resync) bursts during the multi-second load).
    for (const path of paths) {
      if (isGltfLoaded(path) || kicked.has(path)) continue;
      kicked.add(path);
      void loadGltfRuntime(path, fetchProjectBytes, renderer.assets as never).then((loaded) => {
        if (loaded) resync();
        else kicked.delete(path); // failed — allow a later retry
      });
    }
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
