// feat-20260614-ecs-managed-lifecycle-ssot M2 t-w3: world-level round-trip
// net-zero matrix for managed-resource fields.
//
// Verifies AC-12 (requirements §5 / §8 boundary table): every release-dispatch
// path on World must net-zero the BufferPool and ManagedRefStore live counters
// after a spawn -> mutate -> tear-down cycle, for each managed-vocab keyword.
//
// Matrix: 4 vocab x 2 round shapes = 8 cases.
//
// Vocab dimensions (keyword family routed through releaseManagedFieldOnRow
// after w4):
//   - 'string'           -> ManagedRefStore handle (isManagedField arm)
//   - 'ref<T>'           -> ManagedRefStore handle (isManagedField arm)
//   - 'buffer'  variable -> BufferPool slot id    (isManagedBufferField arm)
//   - 'array<T>' variable-> BufferPool slot id    (isManagedArrayField arm)
//
// Round shapes:
//   (R1) spawn -> world.set(e, C, { f: v2 }) -> world.despawn(e)
//   (R2) spawn -> world.removeComponent(e, C) -> world.addComponent(e, C, ...)
//
// R2 uses addComponent (not a second spawn) to stress the same release-dispatch
// path that releaseManagedRefsOnRow walks (research Finding 1.2 row 4 / plan-
// strategy §5.3 M2 key test).
//
// OOS-1: this test only exercises increment release on per-entity despawn /
// per-component remove; it does NOT call any World.clear/dispose path. OOS-2:
// SceneInstance state alloc/release at world.ts:3494/3522 are out of scope
// for the helper (D-5) and not exercised here.
//
// TDD positioning: the round-trip invariant is already in place pre-w4 because
// the dispatch is correct, only duplicated; w3 locks in the invariant before
// the SSOT collapse so w4/w5 reviewers see it stays green through the refactor.

import type { Handle } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { BufferPool } from '../buffer-pool';
import { type Component, defineComponent } from '../component';
import type { ManagedRefStore } from '../managed-ref-store';
import { World } from '../world';

interface MaterialAsset {
  albedo: [number, number, number, number];
}

interface WorldInternals {
  managedRefs: ManagedRefStore;
  bufferPool: BufferPool;
}

function refsOf(w: World): ManagedRefStore {
  return (w as unknown as WorldInternals).managedRefs;
}
function poolOf(w: World): BufferPool {
  return (w as unknown as WorldInternals).bufferPool;
}
function liveRefs(w: World): number {
  return refsOf(w)._liveCount();
}
function liveSlots(w: World): number {
  return poolOf(w)._liveCount();
}

// Allocates a fresh ref<MaterialAsset> handle inside the same World so the
// round-trip ledger stays self-contained: every alloc must net-zero too.
function allocMat(
  w: World,
  albedo: [number, number, number, number],
): Handle<'MaterialAsset', 'managed'> {
  return refsOf(w).alloc<'MaterialAsset', MaterialAsset>('MaterialAsset', { albedo });
}

interface RoundCase {
  vocab: 'string' | 'ref<T>' | 'buffer' | 'array<T>';
  Component: Component;
  v1: () => unknown;
  v2: () => unknown;
  v3: () => unknown;
}

// Build the 4 vocab cases. Each defines a fresh component with one managed
// field of that vocab keyword; the value generators v1/v2/v3 produce
// distinct payloads so the set / addComponent paths actually mutate.
function buildCases(w: World): RoundCase[] {
  const StrName = defineComponent('RtStrName', { value: { type: 'string' } });
  const Mat = defineComponent('RtMat', { material: { type: 'ref<MaterialAsset>' } });
  const Buf = defineComponent('RtBuf', { bytes: { type: 'buffer' } });
  const Arr = defineComponent('RtArr', { ids: { type: 'array<u32>' } });

  return [
    {
      vocab: 'string',
      Component: StrName as unknown as Component,
      v1: () => 'alpha',
      v2: () => 'beta',
      v3: () => 'gamma',
    },
    {
      vocab: 'ref<T>',
      Component: Mat as unknown as Component,
      // The ref<T> vocab requires alloc'ing a handle into the World's
      // ManagedRefStore. The generators alloc inside the round (after the
      // counter snapshot), so the closing despawn / set / removeComponent
      // path must release them back to net-zero.
      v1: () => allocMat(w, [1, 0, 0, 1]),
      v2: () => allocMat(w, [0, 1, 0, 1]),
      v3: () => allocMat(w, [0, 0, 1, 1]),
    },
    {
      vocab: 'buffer',
      Component: Buf as unknown as Component,
      v1: () => new Uint8Array([1, 2, 3, 4]),
      v2: () => new Uint8Array([5, 6, 7, 8, 9]),
      v3: () => new Uint8Array([10]),
    },
    {
      vocab: 'array<T>',
      Component: Arr as unknown as Component,
      v1: () => new Uint32Array([1, 2, 3]),
      v2: () => new Uint32Array([4, 5, 6, 7]),
      v3: () => new Uint32Array([8]),
    },
  ];
}

describe('world managed round-trip net-zero matrix (feat-20260614 M2 / AC-12)', () => {
  describe('R1: spawn -> set -> despawn', () => {
    for (const vocab of ['string', 'ref<T>', 'buffer', 'array<T>'] as const) {
      it(`${vocab}: live counters net-zero after spawn -> set -> despawn`, () => {
        const w = new World();
        const cases = buildCases(w);
        const c = cases.find((cs) => cs.vocab === vocab);
        if (!c) throw new Error('case missing');

        // Snapshot counters BEFORE any value generation. ref<T>'s value
        // generator alloc's into the World's ManagedRefStore inside the
        // round, so the round's full release-dispatch must net-zero those
        // back to 0 by the end of despawn.
        const refsBefore = liveRefs(w);
        const slotsBefore = liveSlots(w);

        const e = w
          .spawn({ component: c.Component, data: { [fieldOf(c)]: c.v1() } as never })
          .unwrap();
        w.set(e, c.Component, { [fieldOf(c)]: c.v2() } as never).unwrap();
        w.despawn(e).unwrap();

        expect(liveRefs(w)).toBe(refsBefore);
        expect(liveSlots(w)).toBe(slotsBefore);
      });
    }
  });

  describe('R2: spawn -> removeComponent -> addComponent', () => {
    for (const vocab of ['string', 'ref<T>', 'buffer', 'array<T>'] as const) {
      it(`${vocab}: live counters net-zero after spawn -> removeComponent -> addComponent`, () => {
        const w = new World();
        const cases = buildCases(w);
        const c = cases.find((cs) => cs.vocab === vocab);
        if (!c) throw new Error('case missing');

        // Snapshot before any v1/v3 alloc so ref<T>'s allocator hits land
        // inside the round; the closing despawn must release both the
        // v1-released-by-removeComponent and the v3-installed-by-addComponent
        // payloads to net-zero the counters.
        const refsBefore = liveRefs(w);
        const slotsBefore = liveSlots(w);

        const e = w
          .spawn({ component: c.Component, data: { [fieldOf(c)]: c.v1() } as never })
          .unwrap();
        w.removeComponent(e, c.Component).unwrap();
        w.addComponent(e, {
          component: c.Component,
          data: { [fieldOf(c)]: c.v3() } as never,
        } as never).unwrap();
        w.despawn(e).unwrap();

        expect(liveRefs(w)).toBe(refsBefore);
        expect(liveSlots(w)).toBe(slotsBefore);
      });
    }
  });
});

function fieldOf(c: RoundCase): string {
  switch (c.vocab) {
    case 'string':
      return 'value';
    case 'ref<T>':
      return 'material';
    case 'buffer':
      return 'bytes';
    case 'array<T>':
      return 'ids';
  }
}
