// w14 — TDD red-phase: entity-state rewritten to handle + activeWorld read face
//
// feat-20260707-editor-world-fork-ssot-level-load-play-activeworld M3 (I1):
// After deleting SessionInternals (_e2h/_h2e/_nextId), entity-state stops
// translating a legacy EntityId into an engine handle. The read helpers take an
// engine EntityHandle directly and read a World (the caller passes
// gateway.activeWorld). This test pins the new API:
//   (a) entName/entComponent/entComponents/entExists/entParent take (world, handle);
//   (b) entComponent returns a StaleHandleResult — { ok:true, value } for a live
//       handle, { ok:false, error:{ code:'stale-entity-handle', hint, entity } }
//       for a stale/despawned handle (AC-14, research Finding 13 P3 fix — no more
//       silent undefined conflating "absent" with "stale");
//   (c) the handle<->id mapping ops are DELETED (entHandle/entLegacyId/entMap/
//       entUnmap/entNextId/entSetNextId/entGetNextId/entIds/entHandles/
//       entRootHandles) — the module must not export them.
//
// This test is RED until w17 (delete SessionInternals) + w18 (rewrite
// entity-state) land.
//
// Constraints from upstream:
//   requirements AC-01: entity-state full handle<->id mapping ops deleted
//   requirements AC-14: stale-entity-handle explicit structured error
//   plan-strategy D-4: read helper normalized to Result on stale handle
//   plan-strategy R-N3: M3 atomic migration — core signatures first
//
// Anchors:
//   plan-tasks.json w14

import { describe, expect, it } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { Name, Transform, ChildOf } from '@forgeax/engine-runtime';
import type { EntityHandle } from '../scene/scene-types';
import * as entityState from '../store/entity-state';
import { entName, entComponent, entComponents, entExists, entParent } from '../store/entity-state';

function spawn(world: World, name: string, parent?: EntityHandle): EntityHandle {
  const comps: Array<{ component: unknown; data: Record<string, unknown> }> = [
    { component: Name, data: { value: name } },
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
  ];
  if (parent !== undefined) comps.push({ component: ChildOf, data: { parent } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = world.spawn(...(comps as any));
  if (!r.ok) throw new Error(`spawn failed: ${String(r.error)}`);
  return r.value as EntityHandle;
}

function staleHandle(): EntityHandle {
  return 0xdeadbeef as EntityHandle;
}

describe('w14 — entity-state handle + activeWorld read face', () => {
  // ── (a) signatures take (world, handle) ──────────────────────────────────
  it('(a) entName(world, handle) reads Name from the world', () => {
    const world = new World();
    const h = spawn(world, 'Alpha');
    expect(entName(world, h)).toBe('Alpha');
  });

  it('(a) entExists(world, handle) is true for a live handle, false for stale', () => {
    const world = new World();
    const h = spawn(world, 'Beta');
    expect(entExists(world, h)).toBe(true);
    expect(entExists(world, staleHandle())).toBe(false);
  });

  it('(a) entComponents(world, handle) returns a component dict keyed by name', () => {
    const world = new World();
    const h = spawn(world, 'Gamma');
    const comps = entComponents(world, h);
    expect(Object.keys(comps)).toContain('Name');
    expect(Object.keys(comps)).toContain('Transform');
  });

  it('(a) entParent(world, handle) returns the parent handle, or null for a root', () => {
    const world = new World();
    const root = spawn(world, 'Root');
    const child = spawn(world, 'Child', root);
    expect(entParent(world, root)).toBeNull();
    expect(entParent(world, child)).toBe(root);
  });

  // ── (b) entComponent returns a StaleHandleResult (AC-14 / Finding 13) ─────
  it('(b) entComponent returns { ok:true, value } for a live handle', () => {
    const world = new World();
    const h = spawn(world, 'Delta');
    const r = entComponent(world, h, 'Transform');
    expect(r.ok).toBe(true);
    if (r.ok) {
      const tv = r.value as { pos: number[]; scale: number[] };
      expect(tv.pos[0]).toBe(0);
      expect(tv.scale[0]).toBe(1);
    }
  });

  it('(b) entComponent returns stale-entity-handle for a stale handle (no silent undefined)', () => {
    const world = new World();
    const stale = staleHandle();
    const r = entComponent(world, stale, 'Transform');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('stale-entity-handle');
      expect(typeof r.error.hint).toBe('string');
      expect(r.error.hint.length).toBeGreaterThan(0);
      expect(r.error.entity).toBe(stale);
    }
  });

  it('(b) entComponent distinguishes stale handle from an absent (but live) component', () => {
    const world = new World();
    const h = spawn(world, 'Epsilon'); // no ChildOf
    const r = entComponent(world, h, 'ChildOf');
    // Live handle, component simply not present: ok:false but NOT stale-entity-handle.
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).not.toBe('stale-entity-handle');
    }
  });

  // ── (c) mapping ops deleted (AC-01) ──────────────────────────────────────
  it('(c) handle<->id mapping ops are deleted from the module', () => {
    const deleted = [
      'entHandle', 'entLegacyId', 'entMap', 'entUnmap', 'entNextId',
      'entSetNextId', 'entGetNextId', 'entIds', 'entHandles', 'entRootHandles',
    ];
    for (const name of deleted) {
      expect((entityState as Record<string, unknown>)[name]).toBeUndefined();
    }
  });

  // ── (d) w27: super handle-pair opts → stale error carries .detail.reason ──
  // feat-20260709 M5 (w27, D-8): when entComponent/entComponents run the
  // three-layer check (opts = binding + pair), the stale case narrows WHY via
  // .detail.reason (epoch vs generation), and a wrong-world handle yields
  // world-mismatch instead of a stale error.
  const WORLD_REF_SCENE = 1;
  const WORLD_REF_EDITOR = 0;

  it('(d) entComponent with a bumped-epoch pair returns detail.reason world-epoch-mismatch', () => {
    const world = new World();
    const h = spawn(world, 'Zeta');
    // Pair minted at epoch 0; the live binding advanced to epoch 1 (a reload).
    const r = entComponent(world, h, 'Transform', {
      binding: { worldRef: WORLD_REF_SCENE, epoch: 1, world },
      pair: { worldRef: WORLD_REF_SCENE, epoch: 0 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === 'stale-entity-handle') {
      expect(r.error.detail?.reason).toBe('world-epoch-mismatch');
      expect(r.error.entity).toBe(h);
    } else {
      throw new Error(`expected stale-entity-handle, got ${r.ok ? 'ok' : r.error.code}`);
    }
  });

  it('(d) entComponent with a despawned entity (same epoch) returns detail.reason stale-entity', () => {
    const world = new World();
    const h = spawn(world, 'Eta');
    world.despawn(h);
    const r = entComponent(world, h, 'Transform', {
      binding: { worldRef: WORLD_REF_SCENE, epoch: 0, world },
      pair: { worldRef: WORLD_REF_SCENE, epoch: 0 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === 'stale-entity-handle') {
      expect(r.error.detail?.reason).toBe('stale-entity');
    } else {
      throw new Error(`expected stale-entity-handle, got ${r.ok ? 'ok' : r.error.code}`);
    }
  });

  it('(d) entComponent with a wrong-world pair returns world-mismatch', () => {
    const world = new World();
    const h = spawn(world, 'Theta');
    // Pair claims the editor world; validated against the scene binding.
    const r = entComponent(world, h, 'Transform', {
      binding: { worldRef: WORLD_REF_SCENE, epoch: 0, world },
      pair: { worldRef: WORLD_REF_EDITOR, epoch: 0 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('world-mismatch');
  });

  it('(d) entComponents with an invalid pair returns {} (batch read guard)', () => {
    const world = new World();
    const h = spawn(world, 'Iota');
    const comps = entComponents(world, h, {
      binding: { worldRef: WORLD_REF_SCENE, epoch: 1, world },
      pair: { worldRef: WORLD_REF_SCENE, epoch: 0 },
    });
    expect(Object.keys(comps).length).toBe(0);
  });
});
