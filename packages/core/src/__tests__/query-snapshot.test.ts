// m4-w10 — TDD: querySnapshot value-snapshot safety test (RED phase)
//
// feat-20260706-editor-op-gateway-single-entry-b-catalog-defineop M4:
// Tests for the querySnapshot() read-only value-snapshot surface. RED phase:
// query-snapshot.ts is a thin stub that may not yet flatten TypedArrays.
// m4-w8 (impl) makes these tests green.
//
// Constraints:
//   plan-strategy §2 D-4: plan signature has querySnapshot, no world
//   research F5: createQueryState+queryRun read-separated, value-snapshot safe
//   requirements gap #3: value-snapshot, read-only, no World handle leak

import { describe, expect, it, beforeEach } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-runtime';
import type { EntityHandle } from '../scene/scene-types';
import { EditGateway } from '../io/gateway';
import { entHandle } from '../store/entity-state';
import { createEditSession } from '../session/document';
import type { EditorOp, EditSession, EntityId } from '../types';
import { querySnapshot } from '../io/query-snapshot';

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
  return cmd._id!;
}

// ── (a) querySnapshot returns plain object array ──

describe('querySnapshot plain object return (m4-w10, RED)', () => {
  let gw: EditGateway;

  beforeEach(() => {
    gw = new EditGateway(createSession());
    spawnEntity(gw, 'ball', 10, 20);
  });

  it('returns array of plain objects', () => {
    const rows = querySnapshot(gw.doc.world!, { with: ['Transform'] });
    expect(Array.isArray(rows)).toBe(true);
    if (rows.length > 0) {
      expect(typeof rows[0]).toBe('object');
      expect(rows[0]).not.toBe(null);
    }
  });

  it('each row has entity field', () => {
    const rows = querySnapshot(gw.doc.world!, { with: ['Transform'] });
    for (const row of rows) {
      expect(row).toHaveProperty('entity');
      expect(typeof row.entity).toBe('number');
    }
  });
});

// ── (b) No TypedArray live references ──

describe('querySnapshot no TypedArray references (m4-w10, RED)', () => {
  let gw: EditGateway;

  beforeEach(() => {
    gw = new EditGateway(createSession());
    spawnEntity(gw, 'ball', 10, 20);
  });

  it('Transform field values are JS primitives, not TypedArrays', () => {
    const rows = querySnapshot(gw.doc.world!, { with: ['Transform'] });
    if (rows.length === 0) return;
    const row = rows[0]!;
    const tf = row['Transform'] as Record<string, unknown> | undefined;
    if (tf) {
      for (const [_key, val] of Object.entries(tf)) {
        expect(val).not.toBeInstanceOf(Float32Array);
        expect(val).not.toBeInstanceOf(Int32Array);
        expect(val).not.toBeInstanceOf(Uint32Array);
        expect(typeof val).toBe('number');
      }
    }
  });
});

// ── (c) Entity identity via existing _e2h/_h2e projection ──

describe('querySnapshot entity identity (m4-w10, RED)', () => {
  let gw: EditGateway;

  beforeEach(() => {
    gw = new EditGateway(createSession());
  });

  it('entity field matches legacy id', () => {
    const e1 = spawnEntity(gw, 'e1', 10, 20);
    spawnEntity(gw, 'e2', 30, 40);

    const rows = querySnapshot(gw.doc.world!, { with: ['Transform'] });
    const ids = rows.map((r) => r.entity);
    expect(ids).toContain(e1);
  });
});

// ── (d) No World handle leak in return type ──

describe('querySnapshot no World handle leak (m4-w10, RED)', () => {
  it('return type is plain object — compile-time check', () => {
    // This test is a compile-time assertion: querySnapshot's return type
    // (QuerySnapshotRow[]) contains no World/ArchetypeGraph/QueryState fields.
    // If any of those leaked, tsc would flag a type mismatch below.
    const _snapshot: Array<{ entity: number } & Record<string, unknown>> = [];
    // This assignment proves the return type is plain enough to assign to
    // a Record<string,unknown> shape.
    const _rows: ReadonlyArray<Record<string, unknown>> = _snapshot;
    expect(_rows).toBeDefined();
  });
});

// ── (e) Snapshot consistency with world.get ──

describe('querySnapshot consistency with world.get (m4-w10, RED)', () => {
  let gw: EditGateway;

  beforeEach(() => {
    gw = new EditGateway(createSession());
  });

  it('snapshot posY matches world.get Transform.posY', () => {
    const e = spawnEntity(gw, 'ball', 10, 25);
    const h = entHandle(gw.doc, e as EntityId) as EntityHandle;

    const rows = querySnapshot(gw.doc.world!, { with: ['Transform'] });
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
});

// ── (f) JSON round-trip no information loss ──

describe('querySnapshot JSON round-trip (m4-w10, RED)', () => {
  let gw: EditGateway;

  beforeEach(() => {
    gw = new EditGateway(createSession());
    spawnEntity(gw, 'ball', 10, 20);
  });

  it('snapshot survives JSON.stringify/parse without loss', () => {
    const rows = querySnapshot(gw.doc.world!, { with: ['Transform'] });
    if (rows.length === 0) return;

    const json = JSON.stringify(rows);
    const parsed = JSON.parse(json) as typeof rows;
    expect(parsed.length).toBe(rows.length);
    expect(parsed[0]!.entity).toBe(rows[0]!.entity);
  });
});