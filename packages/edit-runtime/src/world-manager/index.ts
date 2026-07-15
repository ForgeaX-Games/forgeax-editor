// world-manager — the super coordination layer (plan-strategy §2 D-5).
//
// feat-20260709-editor-world-partition-editorworld-super-composite / M4 (w18).
//
// WorldManager is the ONE component that knows both worlds' roles: it owns the
// editorWorld (camera + gizmo), holds the WorldBinding registry (world + epoch),
// provides the composite drawSource callback, and mints the DEDICATED EngineFacade
// through which editorWorld writes flow. sceneWorld writes are NOT world-manager's
// job — they still go through gateway dispatch (begin/update/commit) so undo /
// ledger / trace semantics are preserved (D-5 dual-track writes). gateway keeps
// only the `activeWorld` read pointer (C3/AC-12); world-manager adds no new write
// responsibility to it.
//
// Write-path discipline (lint-unique-mutator, zero exemption): editorWorld writes
// go through `editorFacade` (a core-minted EngineFacade instance) — raw
// world.set/spawn/despawn never appear in editor source outside engine-facade.ts.
// The facade is minted via core's createEngineFacade factory so the raw
// `new EngineFacade` stays inside that single gate file.
//
// DAG placement (research F4 / RD4): world-manager lives in edit-runtime because
// super's responsibilities span core (selection) and edit-runtime (viewport), and
// core must not up-import edit-runtime. edit-runtime → core is the legal direction.
//
// M4 scope: editorWorld assembly + WorldBinding registry + drawSource + dedicated
// facade. Epoch bump + three-layer handle validation are M5 (w25/w28).
//
// Anchors:
//   plan-strategy §2 D-5 (world-manager落 edit-runtime; dual-track writes)
//   plan-strategy §2 D-2 (editorWorld = new World() + transformPlugin)
//   plan-strategy §2 D-3 (drawSource composite feed)
//   requirements C3 (super = independent module; gateway keeps activeWorld only)

import type { EngineFacade } from '@forgeax/editor-core';
import {
  createEngineFacade,
  gateway,
  registerActiveReadBinding,
  registerSelectionBindingProvider,
  revalidateSelection,
} from '@forgeax/editor-core';
import type { World } from '@forgeax/engine-ecs';
import { createDrawSource, createPlayDrawSource, type DrawSourceResult } from './createDrawSource';
import { createEditorWorld } from './createEditorWorld';
import {
  WorldBindingRegistry,
  WORLD_REF_EDITOR,
  WORLD_REF_SCENE,
  type WorldBinding,
} from './WorldBinding';

export { WORLD_REF_EDITOR, WORLD_REF_SCENE, type WorldBinding } from './WorldBinding';
export { type DrawSourceResult } from './createDrawSource';
export { createEditorWorld } from './createEditorWorld';

/** The five value-move channels super coordinates between the two worlds (D-6 /
 *  research F4). Each has a fixed world ROLE in edit mode:
 *   - 'camera'    → editorWorld (the orbit camera pose lives with the editor);
 *   - 'gizmo'     → editorWorld (the gizmo/param-gizmo overlay entities);
 *   - 'pick'      → sceneWorld (ray vs authored geometry AABB);
 *   - 'drag'      → sceneWorld (moves the authored entity's Transform);
 *   - 'inspector' → sceneWorld (reads/writes the authored entity's components).
 *  This is the SSOT role table the design blueprint (§3.1) names — world-manager
 *  is the ONE component that knows both worlds' roles. */
export type SuperChannel = 'camera' | 'gizmo' | 'pick' | 'drag' | 'inspector';

/**
 * The super coordination layer for the two-world edit topology.
 *
 * Construct once at viewport boot with a lazy accessor for the scene world
 * (`gateway.doc.world`, re-read each frame so a scene swap is picked up). Owns the
 * editorWorld it assembles internally.
 *
 * Call `attach()` once after construction to wire the two core seams (M5 / D-4):
 *   - the selection binding provider — so newly selected handles are minted as
 *     world-bound pairs against the CURRENT (sceneWorld, epoch) binding;
 *   - the scene-reload collar — so a reload bumps the sceneWorld epoch and
 *     revalidates the selection, batch-invalidating every pre-reload pair (AC-05).
 * `attach()` returns a detach fn (unregisters both seams).
 */
export class WorldManager {
  /** The editor-owned world (camera + gizmo). Assembled at construction. */
  readonly editorWorld: World;

  /** The dedicated write proxy for editorWorld (D-5). All camera/gizmo spawn/set/
   *  despawn go through this — never raw world writes (lint-unique-mutator). */
  readonly editorFacade: EngineFacade;

  /** Lazy accessor for the live scene world (doc.world). */
  private readonly _getSceneWorld: () => World | undefined;

  /** Epoch SSOT for all worldRefs (D-5): one registry, no double-write. The
   *  binding OBJECTS are derived on read so they always carry the live epoch. */
  private readonly _registry = new WorldBindingRegistry();

  constructor(getSceneWorld: () => World | undefined) {
    this.editorWorld = createEditorWorld();
    this.editorFacade = createEngineFacade(this.editorWorld);
    this._getSceneWorld = getSceneWorld;
  }

  /** The per-frame composite draw-source callback for createApp's `drawSource`
   *  option: `() => { worlds: [editorWorld, sceneWorld], cameraOwner: 0,
   *  resourceOwner: 1 } | undefined` (undefined until the scene world is injected). */
  createDrawSource(): () => DrawSourceResult | undefined {
    return createDrawSource(this.editorWorld, this._getSceneWorld);
  }

  /**
   * The live play App keeps driving its playWorld, but `play·scene` must render
   * it through the persistent editor orbit camera. This factory supplies that
   * explicit composite without moving an entity handle across worlds.
   */
  createPlayDrawSource(playWorld: World, isEditorView: () => boolean): () => DrawSourceResult | undefined {
    return createPlayDrawSource(this.editorWorld, playWorld, isEditorView);
  }

  /** Resolve the WorldBinding for a worldRef (0=editor, 1=scene). Returns
   *  undefined for the scene ref when doc.world is not yet injected. Epoch comes
   *  from the registry (SSOT) — reflects any prior bumpEpoch. */
  getWorldBinding(worldRef: number): WorldBinding | undefined {
    if (worldRef === WORLD_REF_EDITOR) {
      return this._registry.binding(WORLD_REF_EDITOR, this.editorWorld);
    }
    if (worldRef === WORLD_REF_SCENE) {
      const scene = this._getSceneWorld();
      return scene === undefined ? undefined : this._registry.binding(WORLD_REF_SCENE, scene);
    }
    return undefined;
  }

  /** Advance a worldRef's epoch (D-4). Every handle-pair minted against the prior
   *  epoch fails validateHandlePair's epoch layer in one comparison. */
  bumpEpoch(worldRef: number): void {
    this._registry.bump(worldRef);
  }

  /** The worldRef a value-move channel targets in edit mode (D-6 role map, SSOT).
   *  Camera + gizmo write the editorWorld; pick / drag / inspector read+write the
   *  sceneWorld. This is a PURE mapping — it does not read or copy the input-routing
   *  state (getInputTarget stays the single derivation, viewport-quadrant.ts); it
   *  only names which world each channel's value-move lands in. */
  channelWorldRef(channel: SuperChannel): number {
    switch (channel) {
      case 'camera':
      case 'gizmo':
        return WORLD_REF_EDITOR;
      case 'pick':
      case 'drag':
      case 'inspector':
        return WORLD_REF_SCENE;
    }
  }

  /** Wire the two core seams (selection binding provider + scene-reload collar).
   *  Idempotent per instance is NOT guaranteed — call once; use the returned
   *  detach fn on teardown. */
  attach(): () => void {
    // (1) Selection minting: bind new selections to the live sceneWorld epoch so a
    //     later reload can batch-invalidate them. Selections are scene entities in
    //     edit mode (D-6 channel map: pick/inspector → sceneWorld).
    const unregProvider = registerSelectionBindingProvider(() => ({
      worldRef: WORLD_REF_SCENE,
      epoch: this._registry.epoch(WORLD_REF_SCENE),
    }));

    // (2) Scene reload: bump the sceneWorld epoch FIRST (so the provider now
    //     reports the new epoch), then revalidate — every pair at the old epoch is
    //     dropped in one pass (AC-05 batch invalidation / E1 selection clear).
    const unregReload = gateway.onSceneReload(() => {
      this._registry.bump(WORLD_REF_SCENE);
      revalidateSelection();
    });

    // (3) Active read-binding (VERIFY finding-3 defense-in-depth): publish the live
    //     sceneWorld (worldRef, epoch, world) binding so production READ points
    //     (Inspector) can run the three-layer validateHandlePair check at the read
    //     seam — not only inside the reload collar. In edit mode the active read
    //     world is always the sceneWorld (the inspector reads authored entities);
    //     it is undefined until doc.world is injected, so reads fall back to the
    //     legacy liveness probe before boot (unchanged behavior).
    const unregReadBinding = registerActiveReadBinding(() => {
      const scene = this._getSceneWorld();
      return scene === undefined
        ? undefined
        : this._registry.binding(WORLD_REF_SCENE, scene);
    });

    return () => {
      unregProvider();
      unregReload();
      unregReadBinding();
    };
  }
}
