// EditSession factory (M7: EntityNode + projection dead code deleted).
//
// feat-20260701-editor-world-container-doc-ecs-collapse M7 / AC-15:
// makeEditSession, projectSessionAsset, cloneEditSession deleted — all served
// the EntityNode/doc.entities dual-write mirror. createEditSession now only
// creates a new World instance (the SSOT).
//
// ── feat-20260707-editor-world-fork M3 (I1 / AC-01): legacy id maps deleted ──
//
// The runtime editor identity IS the engine EntityHandle — there is no second
// id namespace. The former per-session legacy id-to-handle maps + id allocator
// are gone; every read/write face takes an EntityHandle directly and reads
// gateway.activeWorld. createEditSession now only mints a World; there is no
// symbol-keyed internal state and no internals accessor.
//
// Anchors:
//   requirements AC-01: legacy id maps deleted, symbol grep zero hits in
//     core/panels/edit-runtime source
//   plan-strategy §2.5: edit-session.ts net-reduction (legacy maps deleted)
//   plan-strategy R-N3: M3 atomic migration — core signatures first

import { World } from '@forgeax/engine-ecs';
import type { EditSession } from '../scene/scene-types';

type WorldType = World;

/** A fresh, empty edit session with a new World.
 *  The edit-runtime replaces this default world with the real app world at
 *  boot via bus.doc.world = world. */
export function createEditSession(): EditSession {
  const world = new World();
  const session = {
    world: world as unknown as WorldType,
  };
  return session as unknown as EditSession;
}
