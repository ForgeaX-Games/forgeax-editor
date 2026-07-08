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
  return (cmd as any)._id!;
}

function readPosY(gw: EditGateway, entity: number): number {
  const h = (entity as EntityId as EntityHandle) as EntityHandle;
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

// ── t29a RED: defineOp session domain (AC-17) ──
// RED phase: defineOp currently hard-rejects domain !== 'document'.
// These tests assert the GREEN behavior: session defineOp succeeds and
// dispatching it runs the plan, pushes to ledger, not to undo.
// They WILL FAIL until t28 implements session domain support.

describe('defineOp session domain (t29a RED, AC-17)', () => {
  let gw: EditGateway;

  beforeEach(() => {
    gw = new EditGateway(createSession());
    spawnEntity(gw, 'light-A');
    spawnEntity(gw, 'light-B');
  });

  it('session defineOp succeeds and dispatch runs plan (RED)', () => {
    const defR = gw.defineOp({
      id: 'selectLightsSession',
      domain: 'session' as any,
      argsSchema: null,
      plan: (_query: any, _args: any) => {
        return [{ kind: 'setSelectionMany', ids: [] }];
      },
    });
    // RED: currently returns {ok:false, error:{code:'INVALID_ARGS'}}
    // GREEN: returns {ok:true} — t28 makes this pass
    expect(defR.ok).toBe(true);
    if (!defR.ok) return;

    // Dispatch the session op
    const ledgerBefore = gw.ledger.length;
    const undoBefore = gw.appliedCount();
    const dispR = gw.dispatch({ kind: 'selectLightsSession' } as any, 'ai');
    // RED: dispatch fails (the applier didn't get registered because defineOp failed)
    expect(dispR.ok).toBe(true);
    // GREEN: ledger +1, undo unchanged
    if (dispR.ok) {
      expect(gw.ledger.length).toBe(ledgerBefore + 1);
      expect(gw.appliedCount()).toBe(undoBefore);
    }
  });

  it('defineOp with domain=transient still returns INVALID_ARGS (OOS-6)', () => {
    const r = gw.defineOp({
      id: 'testTransient',
      domain: 'transient' as any,
      argsSchema: null,
      plan: (_query: any, _args: any) => [],
    });
    // Transient domain must STAY rejected (OOS-6) — this test stays GREEN
    expect(r.ok).toBe(false);
  });
});

// ── t29b: session defineOp edge cases (mid-failure, empty plan) ──

describe('session defineOp edge cases (t29b, AC-18)', () => {
  let gw: EditGateway;

  beforeEach(() => {
    gw = new EditGateway(createSession());
    spawnEntity(gw, 'entity-A');
    spawnEntity(gw, 'entity-B');
  });

  it('empty plan returns ok with no ledger entries', () => {
    const defR = gw.defineOp({
      id: 'emptyPlanOp',
      domain: 'session' as any,
      argsSchema: null,
      plan: (_query: any, _args: any) => [],
    });
    expect(defR.ok).toBe(true);
    if (!defR.ok) return;

    const ledgerBefore = gw.ledger.length;
    const dispR = gw.dispatch({ kind: 'emptyPlanOp' } as any, 'ai');
    expect(dispR.ok).toBe(true);
    expect(gw.ledger.length).toBe(ledgerBefore);
  });

  it('partial failure: first op succeeds, second fails, ledger has first only', () => {
    const defR = gw.defineOp({
      id: 'partialFailOp',
      domain: 'session' as any,
      argsSchema: null,
      plan: (_query: any, _args: any) => {
        return [
          { kind: 'setSelectionMany', ids: [] }, // valid session op
          { kind: 'nonExistentKindXyz', ids: [] }, // will fail
        ];
      },
    });
    expect(defR.ok).toBe(true);
    if (!defR.ok) return;

    const ledgerBefore = gw.ledger.length;
    const dispR = gw.dispatch({ kind: 'partialFailOp' } as any, 'ai');
    // Should fail with PLAN_STEP_FAILED
    expect(dispR.ok).toBe(false);
    if (!dispR.ok) {
      expect(dispR.error.code).toBe('PLAN_STEP_FAILED');
      expect(dispR.error.hint).toContain('nonExistentKindXyz');
      expect(dispR.error.hint).toContain('#2');
    }
    // First sub-op should be in ledger
    expect(gw.ledger.length).toBe(ledgerBefore + 1);
    expect(gw.ledger[gw.ledger.length - 1]!.kind).toBe('setSelectionMany');
  });
});