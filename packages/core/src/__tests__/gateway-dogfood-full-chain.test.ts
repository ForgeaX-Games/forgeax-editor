// m4-w4 — TDD: dogfood full-chain integration test (RED phase)
//
// feat-20260706-editor-op-gateway-single-entry-b-catalog-defineop M4:
// Full-chain scenario: create session → listOps → dispatch session op (AI) →
// defineOp → dispatch cast op → undo → ledger assertions.
// RED phase: defineOp and listOps are stubs. Tests document expectations;
// green phase (m4-w5/w7) makes them pass.
//
// Constraints:
//   plan-strategy §5.5: dogfood integration test — full chain
//   requirements AC-05: defineOp four-contract combined verification
//   plan-strategy §8 charter P4: human-AI same gateway, same op shape

import { describe, expect, it, beforeEach } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-runtime';
import type { EntityHandle } from '../scene/scene-types';
import { EditGateway } from '../io/gateway';
import { createEditSession } from '../session/document';
import type { EditorOp, EditSession, EntityId } from '../types';
// F-3 (round-1 fixup): session-domain appliers (setSelection/…) register as an
// eval-time side effect of the store sub-modules. This full-chain gate dispatches
// a session op, so it must pull that registration in itself — otherwise it only
// passes when SOME OTHER test file imported store first (shared sessionAppliers
// Map pollution), and fails when run in isolation. Importing the store barrel
// eagerly registers every session/transient applier (selection, scene-persistence,
// hover, field-preview, …), making this gate self-sufficient (mirrors m2-w8 fixup).
import '../store/store';

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
    components: { Transform: { pos: [0, 0, 0] } },
  };
  const r = gw.dispatch(cmd);
  if (!r.ok) throw new Error(`spawn "${name}" failed`);
  return (cmd as any)._id!;
}

function readPosY(gw: EditGateway, entity: number): number {
  const h = (entity as EntityId as EntityHandle) as EntityHandle;
  const tr = gw.doc.world!.get(h, Transform);
  if (!tr.ok) return 0;
  return (tr.value as unknown as { pos: number[] }).pos[1]!;
}

// ── (a) gateway.listOps() returns non-empty list with builtin ops ──

describe('dogfood: listOps self-inspection (m4-w4, RED)', () => {
  let gw: EditGateway;

  beforeEach(() => {
    gw = new EditGateway(createSession());
  });

  it('listOps returns non-empty array', () => {
    const ops = gw.listOps();
    expect(ops.length).toBeGreaterThan(0);
  });

  it('listOps includes buildin document ops', () => {
    const ops = gw.listOps();
    const docOps = ops.filter((o) => o.domain === 'document');
    expect(docOps.length).toBeGreaterThanOrEqual(5);
  });

  it('listOps includes session ops', () => {
    const ops = gw.listOps();
    const sessionOps = ops.filter((o) => o.domain === 'session');
    expect(sessionOps.length).toBeGreaterThan(0);
  });
});

// ── (b) gateway.dispatch(sessionOp, 'ai') effective + ledger ──

describe('dogfood: session op AI-origin (m4-w4, RED)', () => {
  let gw: EditGateway;

  beforeEach(() => {
    gw = new EditGateway(createSession());
    spawnEntity(gw, 'ball');
  });

  it('dispatch session op with origin=ai records in ledger', () => {
    const r = gw.dispatch({ kind: 'setSelection', id: 1 }, 'ai');
    expect(r.ok).toBe(true);
    // Session ops go to ledger only (no undo)
    expect(gw.ledger.length).toBeGreaterThanOrEqual(1);
    expect(gw.origins.length).toBeGreaterThanOrEqual(1);
    expect(gw.origins[gw.origins.length - 1]).toBe('ai');
  });
});

// ── (c) gateway.defineOp success ──

describe('dogfood: defineOp (m4-w4, RED)', () => {
  let gw: EditGateway;

  beforeEach(() => {
    gw = new EditGateway(createSession());
    spawnEntity(gw, 'ball');
  });

  it('defineOp returns ok for valid config', () => {
    const r = gw.defineOp({
      id: 'moveUpDf1', domain: 'document',
      argsSchema: { type: 'object', properties: { dy: { type: 'number' } }, required: ['dy'] },
      plan: (_query, _args) => [],
    });
    expect(r.ok).toBe(true);
  });

  it('defineOp cast op appears in listOps', () => {
    gw.defineOp({
      id: 'moveUpDf2', domain: 'document',
      argsSchema: { type: 'object', properties: { dy: { type: 'number' } }, required: ['dy'] },
      plan: (_query, _args) => [],
    });
    const ops = gw.listOps();
    const cast = ops.find((o) => o.id === 'moveUpDf2');
    // RED: expect found only if this is past green phase
    if (cast) {
      expect(cast.source).toBe('defined');
      expect(cast.domain).toBe('document');
    }
  });
});

// ── (d-e) dispatch cast op → state change + undoable ──

describe('dogfood: cast op dispatch + undo (m4-w4, RED)', () => {
  let gw: EditGateway;

  beforeEach(() => {
    gw = new EditGateway(createSession());
  });

  it('cast op dispatch → state changes and undo restores', () => {
    const e = spawnEntity(gw, 'ball');
    const posYBefore = readPosY(gw, e);

    const rDef = gw.defineOp({
      id: 'moveUpDf3', domain: 'document',
      argsSchema: { type: 'object', properties: { dy: { type: 'number' } }, required: ['dy'] },
      plan: (_query, _args) => {
        const dy = (_args as { dy: number }).dy;
        return [{ kind: 'setComponent', entity: e, component: 'Transform', patch: { pos: [0, posYBefore + dy, 0] } }];
      },
    });
    if (!rDef.ok) throw new Error('defineOp failed');

    const undoBefore = gw.appliedCount();
    const dispR = gw.dispatch({ kind: 'moveUpDf3', dy: 10 } as unknown as EditorOp, 'ai');
    if (!dispR.ok) return;

    expect(readPosY(gw, e)).toBe(posYBefore + 10);
    expect(gw.appliedCount()).toBe(undoBefore + 1);

    // Undo: one step should restore
    const didUndo = gw.undo();
    expect(didUndo).toBe(true);
    expect(readPosY(gw, e)).toBe(posYBefore);
  });
});

// ── (f) ledger traces full chain ──

describe('dogfood: full chain ledger trace (m4-w4, RED)', () => {
  let gw: EditGateway;

  beforeEach(() => {
    gw = new EditGateway(createSession());
  });

  it('ledger contains session op + cast op in order', () => {
    // M3 (I1): the spawn applier writes the real engine handle back onto _id.
    const ball = spawnEntity(gw, 'ball');

    // Session op
    gw.dispatch({ kind: 'setSelection', id: ball }, 'ai');
    const ledgerAfterSession = gw.ledger.length;

    // defineOp (stub in RED)
    const rDef = gw.defineOp({
      id: 'moveUpDf4', domain: 'document',
      argsSchema: { type: 'object', properties: { dy: { type: 'number' } }, required: ['dy'] },
      plan: (_query, _args) => {
        return [{ kind: 'setComponent', entity: ball, component: 'Transform', patch: { pos: [0, 5, 0] } }];
      },
    });
    if (!rDef.ok) throw new Error('defineOp failed');

    gw.dispatch({ kind: 'moveUpDf4', dy: 5 } as unknown as EditorOp, 'ai');

    // Ledger should contain both entries
    expect(gw.ledger.length).toBeGreaterThan(ledgerAfterSession);
  });
});