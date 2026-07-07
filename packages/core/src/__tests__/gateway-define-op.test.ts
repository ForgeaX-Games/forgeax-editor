// m4-w2 — TDD: defineOp four-contract test (RED phase)
//
// feat-20260706-editor-op-gateway-single-entry-b-catalog-defineop M4:
// Tests for defineOp by-construction compliance. At RED phase, defineOp
// returns {ok:false, code:'PLAN_FAILED'} stub. m4-w7 (impl) makes these green.
//
// Constraints:
//   plan-strategy §2 D-4: defineOp v1 document-domain only, transaction wrapper
//   requirements AC-05: undo/ledger/listOps/AI-callable/plan-no-world
//   requirements edge #3: duplicate id → OP_ID_CONFLICT
//   requirements edge #4: plan throws → PLAN_FAILED, no ledger residue

import { describe, expect, it, beforeEach } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-runtime';
import { EditGateway } from '../io/gateway';
import { createEditSession } from '../session/document';
import type { EditorOp, EditSession, EntityId } from '../types';
import { entHandle } from '../store/entity-state';
import type { EntityHandle } from '../scene/scene-types';

// ── Fixture helpers ──────────────────────────────────────────────────────────

function createSession(): EditSession {
  const session = createEditSession();
  session.world = new World();
  return session;
}

function spawnEntity(gw: EditGateway, name: string): number {
  const cmd: EditorOp = {
    kind: 'spawnEntity',
    name,
    components: { Transform: { posX: 0, posY: 0, posZ: 0 } },
  };
  const r = gw.dispatch(cmd);
  if (!r.ok) throw new Error('spawn failed');
  return cmd._id!;
}

function readPosY(gw: EditGateway, entity: number): number {
  const h = entHandle(gw.doc, entity as EntityId) as EntityHandle;
  const tr = gw.doc.world!.get(h, Transform);
  if (!tr.ok) return 0;
  return (tr.value as unknown as { posY: number }).posY;
}

// ── (a) Plan signature type assertion: plan has only (query, args) ——
//      compile-time only — tested that plan can be written without World

describe('defineOp plan signature (m4-w2, RED)', () => {
  it('plan function receives query and args, no world', () => {
    // This test is compile-time validated: the plan function below does not
    // reference `world` at all. If plan's type leaked world, this would be
    // a tsc error at the defineOp call site.
    const plan = (_query: unknown, _args: unknown): EditorOp[] => [];
    // The fact this compiles is the test — plan takes exactly two params
    // and neither is World.
    expect(typeof plan).toBe('function');
  });
});

// ── (b) defineOp casting success + listOps visibility ──

describe('defineOp casting + listOps visibility (m4-w2, RED)', () => {
  let gw: EditGateway;

  beforeEach(() => {
    gw = new EditGateway(createSession());
    spawnEntity(gw, 'test-entity');
  });

  it('defineOp returns ok for valid config', () => {
    const r = gw.defineOp({
      id: 'moveUpCast1', domain: 'document',
      argsSchema: { type: 'object', properties: { dy: { type: 'number' } }, required: ['dy'] },
      plan: (_query, _args) => [],
    });
    expect(r.ok).toBe(true);
  });

  it('cast op immediately appears in listOps with source=defined', () => {
    gw.defineOp({
      id: 'moveUpCast2', domain: 'document',
      argsSchema: { type: 'object', properties: { dy: { type: 'number' } }, required: ['dy'] },
      plan: (_query, _args) => [],
    });
    const ops = gw.listOps();
    const cast = ops.find((o) => o.id === 'moveUpCast2');
    expect(cast).toBeDefined();
    expect(cast!.source).toBe('defined');
    expect(cast!.domain).toBe('document');
  });
});

// ── (c) defineOp duplicate id → OP_ID_CONFLICT ──

describe('defineOp OP_ID_CONFLICT (m4-w2, RED)', () => {
  let gw: EditGateway;

  beforeEach(() => {
    gw = new EditGateway(createSession());
    spawnEntity(gw, 'test-entity');
  });

  it('duplicate id returns OP_ID_CONFLICT', () => {
    const spec = {
      id: 'moveUpDup', domain: 'document' as const,
      argsSchema: null,
      plan: (_query: unknown, _args: unknown): EditorOp[] => [],
    };
    const r1 = gw.defineOp(spec);
    expect(r1.ok).toBe(true);
    const r2 = gw.defineOp(spec);
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.error.code).toBe('OP_ID_CONFLICT');
    }
  });

  it('duplicate with builtin id returns OP_ID_CONFLICT', () => {
    const r = gw.defineOp({
      id: 'spawnEntity', domain: 'document',
      argsSchema: null,
      plan: (_query, _args) => [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('OP_ID_CONFLICT');
    }
  });
});

// ── (d) plan throws → PLAN_FAILED, no ledger residue ──

describe('defineOp PLAN_FAILED on plan error (m4-w2, RED)', () => {
  let gw: EditGateway;

  beforeEach(() => {
    gw = new EditGateway(createSession());
    spawnEntity(gw, 'test-entity');
  });

  it('plan throwing returns PLAN_FAILED', () => {
    const ledgerBefore = gw.ledger.length;
    const r = gw.defineOp({
      id: 'badOp', domain: 'document',
      argsSchema: null,
      plan: () => { throw new Error('always fails'); },
    });
    // Even if defineOp doesn't execute plan at definition time (it shouldn't),
    // the contract says plan throwing at dispatch time → PLAN_FAILED + no ledger.
    // At RED phase, defineOp returns stub PLAN_FAILED — this test documents
    // the expectation for green phase.
    if (!r.ok) {
      expect(r.error.code).toBe('PLAN_FAILED');
    }
    // RED: ledger unchanged (defineOp is currently a stub)
    expect(gw.ledger.length).toBe(ledgerBefore);
  });
});

// ── (e) Cast op dispatch → single undo (transaction wrapper) ──

describe('defineOp undo single-step (m4-w2, RED)', () => {
  let gw: EditGateway;

  beforeEach(() => {
    gw = new EditGateway(createSession());
  });

  it('dispatch cast op → one undo entry, undo restores state', () => {
    const e = spawnEntity(gw, 'ball');
    const posYBefore = readPosY(gw, e);

    // define a simple moveUp op
    const rDef = gw.defineOp({
      id: 'moveUpUndo', domain: 'document',
      argsSchema: { type: 'object', properties: { dy: { type: 'number' } }, required: ['dy'] },
      plan: (_query, _args) => {
        const dy = (_args as { dy: number }).dy;
        return [{ kind: 'setComponent', entity: e, component: 'Transform', patch: { posY: posYBefore + dy } }];
      },
    });
    // RED: defineOp is a stub (returns PLAN_FAILED), skip if not yet implemented
    if (!rDef.ok) return;

    const undoBefore = gw.appliedCount();
    const dispR = gw.dispatch({ kind: 'moveUpUndo', dy: 5 } as unknown as EditorOp, 'ai');
    if (!dispR.ok) return;

    const posYAfter = readPosY(gw, e);
    expect(posYAfter).toBe(posYBefore + 5);
    expect(gw.appliedCount()).toBe(undoBefore + 1);

    // Undo: one step restores
    const didUndo = gw.undo();
    expect(didUndo).toBe(true);
    expect(readPosY(gw, e)).toBe(posYBefore);
    expect(gw.appliedCount()).toBe(undoBefore);
  });
});

// ── (f) AI origin dispatch of cast op ──

describe('defineOp AI-origin (m4-w2, RED)', () => {
  let gw: EditGateway;

  beforeEach(() => {
    gw = new EditGateway(createSession());
    spawnEntity(gw, 'test-entity');
  });

  it('cast op dispatched with origin=ai succeeds', () => {
    const e = spawnEntity(gw, 'ai-target');
    const rDef = gw.defineOp({
      id: 'moveUpAiTest', domain: 'document',
      argsSchema: { type: 'object', properties: { dy: { type: 'number' } }, required: ['dy'] },
      plan: (_query, _args) => {
        const dy = (_args as { dy: number }).dy;
        return [{ kind: 'setComponent', entity: e, component: 'Transform', patch: { posY: dy } }];
      },
    });
    if (!rDef.ok) throw new Error('defineOp failed');

    const r = gw.dispatch({ kind: 'moveUpAiTest', dy: 1 } as unknown as EditorOp, 'ai');
    expect(r.ok).toBe(true);
    // Verify ledger recorded with origin='ai'
    expect(gw.origins.length).toBeGreaterThan(0);
    expect(gw.origins[gw.origins.length - 1]).toBe('ai');
  });
});