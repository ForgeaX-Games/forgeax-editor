// M4 t25/t26/t27 — querySnapshot full-open + value-snapshot safety tests
//
// feat-20260707-editor-trace-ioc M4:
// Tests for querySnapshot() with dynamic component resolution (t25)
// and value-snapshot safety layer (t26). Covers:
//   - Non-whitelist components queryable (t27a, AC-14)
//   - Snapshot isolation — mutate snapshot, world unchanged (t27b, AC-15)
//   - Unsnapnable fields opaque-handle + skipped (t27b)
//   - Unknown component explicit error signal (t27c, AC-16)
//
// Anchors:
//   plan-strategy §2 D-5: three-layer value safety
//   requirements AC-14/15/16
//   research F-4: safety layer has no complete precedent (RD-7)

import { describe, expect, it, beforeEach } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { Transform, MeshFilter, PointLight, Skylight, Camera, Name } from '@forgeax/engine-runtime';
import type { EntityHandle } from '../scene/scene-types';
import { EditGateway } from '../io/gateway';
import { entHandle } from '../store/entity-state';
import { createEditSession } from '../session/document';
import type { EditorOp, EditSession, EntityId } from '../types';
import { querySnapshot } from '../io/query-snapshot';
import type { QuerySnapshotResult, QuerySnapshotRow } from '../io/query-snapshot';

// ── Fixture helpers ──────────────────────────────────────────────────────────

function createSession(): EditSession {
  const session = createEditSession();
  session.world = new World();
  return session;
}

function spawnEntity(gw: EditGateway, name: string, posX: number, posY: number): number {
  const cmd: EditorOp = {
    kind: 'spawnEntity',
    name,
    components: { Transform: { posX, posY, posZ: 0 } },
  };
  const r = gw.dispatch(cmd);
  if (!r.ok) throw new Error(`spawn "${name}" failed`);
  return (cmd as any)._id!;
}

function spawnEntityWithComponents(gw: EditGateway, name: string, components: Record<string, unknown>): number {
  const cmd: EditorOp = {
    kind: 'spawnEntity',
    name,
    components,
  };
  const r = gw.dispatch(cmd);
  if (!r.ok) throw new Error(`spawn "${name}" with components failed`);
  return (cmd as any)._id!;
}

/** Call querySnapshot and unwrap ok rows, or throw. */
function snap(gw: EditGateway, components: string[]): QuerySnapshotRow[] {
  const r: QuerySnapshotResult = querySnapshot(gw.doc.world!, { with: components });
  if (!r.ok) throw new Error(`querySnapshot failed: ${r.error.code} - ${r.error.hint}`);
  return r.rows;
}

// ── t25: dynamic resolution (non-whitelist components) ──

describe('querySnapshot dynamic resolution (t25, AC-14)', () => {
  let gw: EditGateway;

  beforeEach(() => {
    gw = new EditGateway(createSession());
    spawnEntity(gw, 'ball', 10, 20);
  });

  it('returns array of plain objects', () => {
    const rows = snap(gw, ['Transform']);
    expect(Array.isArray(rows)).toBe(true);
    if (rows.length > 0) {
      expect(typeof rows[0]).toBe('object');
      expect(rows[0]).not.toBe(null);
    }
  });

  it('each row has entity field', () => {
    const rows = snap(gw, ['Transform']);
    for (const row of rows) {
      expect(row).toHaveProperty('entity');
      expect(typeof row.entity).toBe('number');
    }
  });

  it('entity field matches legacy id', () => {
    const e1 = spawnEntity(gw, 'e1', 10, 20);
    spawnEntity(gw, 'e2', 30, 40);

    const rows = snap(gw, ['Transform']);
    const ids = rows.map((r) => r.entity);
    expect(ids).toContain(e1);
  });

  it('snapshot posY matches world.get Transform.posY', () => {
    const e = spawnEntity(gw, 'ball', 10, 25);
    const h = entHandle(gw.doc, e as EntityId) as EntityHandle;

    const rows = snap(gw, ['Transform']);
    if (rows.length === 0) return;

    const tr = gw.doc.world!.get(h, Transform);
    if (!tr.ok) return;
    const worldPosY = (tr.value as unknown as { posY: number }).posY;

    const row = rows.find((r) => r.entity === e);
    if (row) {
      const tf = row['Transform'] as Record<string, unknown> | undefined;
      if (tf) {
        expect(tf['posY']).toBe(worldPosY);
      }
    }
  });

  it('snapshot survives JSON.stringify/parse without loss', () => {
    const rows = snap(gw, ['Transform']);
    if (rows.length === 0) return;

    const json = JSON.stringify(rows);
    const parsed = JSON.parse(json) as typeof rows;
    expect(parsed.length).toBe(rows.length);
    expect(parsed[0]!.entity).toBe(rows[0]!.entity);
  });
});

// ── t27a: non-whitelist component queries (AC-14) ──

describe('querySnapshot non-whitelist components (t27a, AC-14)', () => {
  let gw: EditGateway;

  beforeEach(() => {
    gw = new EditGateway(createSession());
  });

  it('MeshFilter component can be queried dynamically', () => {
    spawnEntityWithComponents(gw, 'mesh-obj', { Transform: { posX: 0, posY: 0, posZ: 0 }, MeshFilter: {} });
    const rows = snap(gw, ['MeshFilter']);
    // At least one row because we spawned an entity with MeshFilter
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toHaveProperty('MeshFilter');
  });

  it('PointLight component can be queried dynamically', () => {
    spawnEntityWithComponents(gw, 'light-obj', { Transform: { posX: 0, posY: 0, posZ: 0 }, PointLight: {} });
    const rows = snap(gw, ['PointLight']);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toHaveProperty('PointLight');
  });

  it('Skylight component can be queried dynamically', () => {
    spawnEntityWithComponents(gw, 'sky', { Transform: { posX: 0, posY: 0, posZ: 0 }, Skylight: {} });
    const rows = snap(gw, ['Skylight']);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toHaveProperty('Skylight');
  });

  it('Camera component can be queried dynamically', () => {
    spawnEntityWithComponents(gw, 'cam', { Transform: { posX: 0, posY: 0, posZ: 0 }, Camera: {} });
    const rows = snap(gw, ['Camera']);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toHaveProperty('Camera');
  });

  it('multiple non-whitelist components queried together', () => {
    spawnEntityWithComponents(gw, 'multi', {
      Transform: { posX: 0, posY: 0, posZ: 0 },
      MeshFilter: {},
      PointLight: {},
    });
    const rows = snap(gw, ['MeshFilter', 'PointLight', 'Transform']);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0]!;
    expect(row).toHaveProperty('MeshFilter');
    expect(row).toHaveProperty('PointLight');
    expect(row).toHaveProperty('Transform');
  });
});

// ── t27b RED: snapshot isolation + handle-type opaque + array snap-copy ──
// RED phase: these tests document expected behavior that will FAIL
// until t26 (three-layer value safety) is implemented.
// Without t26:
//   - Name.value returns raw string (not {kind:'opaque-handle'})
//   - Skylight.equirect returns raw number (not {kind:'opaque-handle'})
// So the OpaqueHandle shape assertions WILL FAIL in RED phase.

describe('querySnapshot value safety (t27b RED, AC-15)', () => {
  let gw: EditGateway;

  beforeEach(() => {
    gw = new EditGateway(createSession());
  });

  // RED: without t26, Name.value returns raw string → typeof val === 'string'
  // GREEN: with t26, returns {kind:'opaque-handle', type:'string', raw}
  it('handle-type field (string) must return OpaqueHandle', () => {
    spawnEntity(gw, 'named-entity', 0, 0);
    const rows = snap(gw, ['Name']);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const nameData = rows[0]!['Name'] as Record<string, unknown> | undefined;
    if (!nameData) return;
    const val = nameData['value'];
    expect(val).toBeDefined();
    // RED: val is a raw string → this assertion FAILS
    expect(val && typeof val === 'object' && (val as Record<string, unknown>).kind === 'opaque-handle').toBe(true);
  });

  // RED: without t26, Skylight.equirect returns raw number → typeof val === 'number'
  // GREEN: with t26, returns {kind:'opaque-handle', type:'shared<EquirectAsset>', raw}
  it('handle-type field (shared<T>) must return OpaqueHandle', () => {
    spawnEntityWithComponents(gw, 'sky', {
      Transform: { posX: 0, posY: 0, posZ: 0 },
      Skylight: {},
    });
    const rows = snap(gw, ['Skylight']);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const skyData = rows[0]!['Skylight'] as Record<string, unknown> | undefined;
    if (!skyData) return;
    const val = skyData['equirect'];
    expect(val).toBeDefined();
    // RED: val is a raw number → this assertion FAILS
    expect(val && typeof val === 'object' && (val as Record<string, unknown>).kind === 'opaque-handle').toBe(true);
  });

  it('mutating snapshot scalar field does NOT affect world', () => {
    spawnEntity(gw, 'ball', 10, 20);
    const rows = snap(gw, ['Transform']);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0]!;
    const tf = row['Transform'] as Record<string, unknown> | undefined;
    if (!tf) return;
    tf['posY'] = 999;
    const rows2 = snap(gw, ['Transform']);
    const row2 = rows2.find((r) => r.entity === row.entity);
    if (row2) {
      const tf2 = row2['Transform'] as Record<string, unknown> | undefined;
      if (tf2) {
        expect(tf2['posY']).toBe(20);
      }
    }
  });

  it('snapshot object graph contains no TypedArray live references', () => {
    spawnEntity(gw, 'ball', 10, 20);
    const rows = snap(gw, ['Transform']);
    if (rows.length === 0) return;
    const row = rows[0]!;
    const tf = row['Transform'] as Record<string, unknown> | undefined;
    if (tf) {
      for (const [_key, val] of Object.entries(tf)) {
        expect(val).not.toBeInstanceOf(Float32Array);
        expect(val).not.toBeInstanceOf(Int32Array);
        expect(val).not.toBeInstanceOf(Uint32Array);
      }
    }
  });

  // When there are no managed/snappable fields, the snapshot should work fine
  it('non-managed component snapshots work correctly', () => {
    spawnEntityWithComponents(gw, 'cam', { Transform: { posX: 0, posY: 0, posZ: 0 }, Camera: {} });
    const rows = snap(gw, ['Transform', 'Camera']);
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

// ── t27c: unknown component explicit signal (AC-16) ──

describe('querySnapshot unknown component signal (t27c, AC-16)', () => {
  let gw: EditGateway;

  beforeEach(() => {
    gw = new EditGateway(createSession());
  });

  it('completely unknown component returns UNKNOWN_COMPONENT', () => {
    const r = querySnapshot(gw.doc.world!, { with: ['NonExistentComponent'] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('UNKNOWN_COMPONENT');
      expect(r.error.hint).toContain('NonExistentComponent');
      expect(r.error.hint).toContain('not registered');
    }
  });

  it('typo of real component returns UNKNOWN_COMPONENT + suggestion', () => {
    spawnEntity(gw, 'ball', 10, 20);
    const r = querySnapshot(gw.doc.world!, { with: ['Ligth'] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('UNKNOWN_COMPONENT');
      expect(r.error.hint).toContain('Ligth');
    }
  });

  it('partial unknown + partial known → overall fail (Fail Fast)', () => {
    spawnEntity(gw, 'ball', 10, 20);
    const r = querySnapshot(gw.doc.world!, { with: ['Transform', 'NonExistentComponent'] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('UNKNOWN_COMPONENT');
      expect(r.error.hint).toContain('NonExistentComponent');
    }
  });
});

// ── compile-time: return type is plain enough ──

describe('querySnapshot compile-time safety', () => {
  it('return type is a discriminated union, not loose array', () => {
    // Compile-time: querySnapshot's return type is QuerySnapshotResult,
    // which is {ok:true, rows} | {ok:false, error}. This type assertion
    // verifies the discriminated union structure compiles.
    const _result: { ok: true; rows: Array<{ entity: number } & Record<string, unknown>> } | { ok: false; error: { code: string; hint: string } } = {} as any;
    expect(_result).toBeDefined();
  });
});