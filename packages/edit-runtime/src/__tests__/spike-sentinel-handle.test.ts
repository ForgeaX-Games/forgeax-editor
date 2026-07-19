// w7 SPIKE (feat-20260705 M3 / plan-strategy §S-2 hard gate):
// Empirically prove the engine u32 `shared<MeshAsset>` column accepts the raw
// value 0 as a MeshFilter.assetHandle sentinel at spawn time.
//
// WHY: M3's GUID bridge (drag-asset-spawn mesh branch, plan-strategy §D-2/D-3)
// emits `MeshFilter: { assetHandle: 0 }` as a placeholder that the
// drag-spawn-resolve bridge later overwrites with the real handle. If the engine
// rejects 0 at spawn (throws / crashes / retains a bogus ref-count), the whole
// "spawn-with-sentinel, then patch handle over bus" approach is unsound and the
// milestone must fall back to a spawn-without-MeshFilter + addComponent path
// (which has a save-empty-node window that needs orchestrator adjudication).
//
// This is a yes/no evidence spike (plan-strategy §S-2). It also stays as a
// regression guard: if a future engine bump makes 0 unacceptable, this fails
// loudly instead of the bridge silently spawning broken entities.
//
// Anchors:
//   plan-tasks.json w7: assert w.spawn({MeshFilter:{assetHandle:0}}) round-trips
//   plan-strategy §S-2: sentinel spike is the M3 hard gate
//   research Finding 4(c): MeshFilter.assetHandle is u32-stored shared<MeshAsset>

import { describe, expect, it } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import type { Handle } from '@forgeax/engine-ecs';
import { MeshFilter, Transform } from '@forgeax/engine-runtime';

// `assetHandle` is a branded Handle<'MeshAsset','shared'> (u32-stored). The whole
// point of the spike is that the RUNTIME u32 column accepts the raw value 0 as a
// sentinel — the compile-time brand does not permit a bare number literal, so we
// cast the sentinel through the brand. If this cast ever becomes unnecessary
// (engine exposing a sentinel constant) the spike still asserts the same runtime
// behavior.
const SENTINEL = 0 as unknown as Handle<'MeshAsset', 'shared'>;

describe('w7 spike: MeshFilter.assetHandle=0 sentinel round-trips through engine spawn', () => {
  it('spawns with assetHandle:0 and reads back 0 (u32 column accepts the sentinel)', () => {
    const world = new World();

    const spawnRes = world.spawn(
      { component: Transform, data: { pos: [0, 0.5, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
      { component: MeshFilter, data: { assetHandle: SENTINEL } },
    );

    // (1) spawn must succeed — a rejection here (throw / Result.err) means the
    //     sentinel approach is unsound; report BLOCKED with engine version.
    expect(spawnRes.ok).toBe(true);
    if (!spawnRes.ok) return;

    const entity = spawnRes.value;

    // (2) MeshFilter.assetHandle reads back exactly 0 — the u32 column stored the
    //     sentinel verbatim (no ref-count retain of an unregistered value).
    const mf = world.get(entity, MeshFilter);
    expect(mf.ok).toBe(true);
    if (!mf.ok) return;
    expect(mf.value.assetHandle as unknown as number).toBe(0);
  });
});
