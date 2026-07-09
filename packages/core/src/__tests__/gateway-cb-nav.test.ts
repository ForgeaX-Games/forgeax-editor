// gateway-cb-nav.test.ts — gateway routing + ledger integration tests (M3 t12)
//
// Covers:
//   AC-3.1: gateway.listOps() contains setCBPath/cbGoBack/cbGoForward
//             with domain=session; setCBPath.argsSchema.path.required===true
//   AC-3.2: dispatch setCBPath → ledger appended, origins appended,
//             getCBNavState() reflects new path
//   AC-3.3: dispatch cbGoBack → undo stack NOT grown (session domain — no inverse)
//   AC-4.2: CB nav ops are AI-dispatchable: origin='ai'/'human' both recorded
//
// All tests use fresh EditGateway instances for ledger isolation.
// Module-level cb-nav state is shared; tests assert relative increments.
//
// Importing '../index' triggers all session applier side-effects including cb-nav.

import { describe, expect, it, beforeEach } from 'bun:test';
import { EditGateway } from '../io/gateway';
import { createEditSession } from '../session/document';
import { getCBNavState } from '../store/cb-nav';
import '../index'; // triggers cb-nav applier registration (side-effect import)

function makeGW(): EditGateway {
  return new EditGateway(createEditSession());
}

// ── AC-3.1: listOps contains the three CB nav ops ─────────────────────────
describe('AC-3.1: listOps includes CB nav ops (domain=session)', () => {
  let gw: EditGateway;
  beforeEach(() => { gw = makeGW(); });

  it('setCBPath is in listOps with domain=session', () => {
    const ops = gw.listOps();
    const op = ops.find(o => o.id === 'setCBPath');
    expect(op).toBeDefined();
    expect(op!.domain).toBe('session');
  });

  it('cbGoBack is in listOps with domain=session', () => {
    const ops = gw.listOps();
    const op = ops.find(o => o.id === 'cbGoBack');
    expect(op).toBeDefined();
    expect(op!.domain).toBe('session');
  });

  it('cbGoForward is in listOps with domain=session', () => {
    const ops = gw.listOps();
    const op = ops.find(o => o.id === 'cbGoForward');
    expect(op).toBeDefined();
    expect(op!.domain).toBe('session');
  });

  it('setCBPath argsSchema declares path as required (JSON-Schema required[] shape)', () => {
    const ops = gw.listOps();
    const op = ops.find(o => o.id === 'setCBPath');
    expect(op).toBeDefined();
    expect(op!.argsSchema).not.toBeNull();
    const schema = op!.argsSchema as { properties?: { path?: unknown }; required?: string[] };
    expect(schema.properties?.path).toBeDefined();
    expect(schema.required).toContain('path');
  });
});

// ── AC-3.2: dispatch setCBPath → ledger + origins + state update ──────────
describe('AC-3.2: setCBPath dispatch records in ledger and origins', () => {
  let gw: EditGateway;
  beforeEach(() => { gw = makeGW(); });

  it('dispatch setCBPath appends one entry to ledger', () => {
    const ledgerBefore = gw.ledger.length;
    gw.dispatch({ kind: 'setCBPath', path: '/x' });
    expect(gw.ledger.length).toBe(ledgerBefore + 1);
    expect((gw.ledger[gw.ledger.length - 1] as { kind: string }).kind).toBe('setCBPath');
  });

  it('dispatch setCBPath appends one entry to origins', () => {
    const originsBefore = gw.origins.length;
    gw.dispatch({ kind: 'setCBPath', path: '/x' }, 'human');
    expect(gw.origins.length).toBe(originsBefore + 1);
    expect(gw.origins[gw.origins.length - 1]).toBe('human');
  });

  it('getCBNavState() reflects path after dispatch', () => {
    gw.dispatch({ kind: 'setCBPath', path: '/state-check' });
    expect(getCBNavState().path).toBe('/state-check');
  });

  it('duplicate setCBPath dispatch still appends to ledger (dedup only in stack)', () => {
    gw.dispatch({ kind: 'setCBPath', path: '/dup' });
    const ledgerBefore = gw.ledger.length;
    // Same path again — dedup prevents history stack growth, but ledger must grow
    gw.dispatch({ kind: 'setCBPath', path: '/dup' });
    expect(gw.ledger.length).toBe(ledgerBefore + 1);
  });
});

// ── AC-3.3: cbGoBack does NOT write to the undo stack ─────────────────────
describe('AC-3.3: cbGoBack is session-domain — undo stack unaffected', () => {
  let gw: EditGateway;
  beforeEach(() => {
    gw = makeGW();
    // Navigate to a path so goBack has an actual state change to make
    gw.dispatch({ kind: 'setCBPath', path: '/nav-test' });
  });

  it('cbGoBack grows ledger but NOT the undo stack', () => {
    const undoBefore = gw.appliedCount();
    const ledgerBefore = gw.ledger.length;

    gw.dispatch({ kind: 'cbGoBack' });

    expect(gw.ledger.length).toBe(ledgerBefore + 1);       // ledger grows
    expect(gw.appliedCount()).toBe(undoBefore);            // undo stack frozen (no inverse)
  });

  it('setCBPath also does not write the undo stack', () => {
    const undoBefore = gw.appliedCount();
    gw.dispatch({ kind: 'setCBPath', path: '/no-undo' });
    expect(gw.appliedCount()).toBe(undoBefore);
  });
});

// ── AC-4.2: AI-dispatchable — origin='ai'/'human' recorded in ledger+origins ─
describe('AC-4.2: CB nav ops are AI-dispatchable (origin tracked)', () => {
  let gw: EditGateway;
  beforeEach(() => { gw = makeGW(); });

  it('setCBPath dispatched with origin=ai records ai in origins', () => {
    const originsBefore = gw.origins.length;
    const r = gw.dispatch({ kind: 'setCBPath', path: '/ai-path' }, 'ai');
    expect(r.ok).toBe(true);
    expect(gw.origins.length).toBe(originsBefore + 1);
    expect(gw.origins[gw.origins.length - 1]).toBe('ai');
  });

  it('setCBPath dispatched with origin=human records human in origins', () => {
    const r = gw.dispatch({ kind: 'setCBPath', path: '/human-path' }, 'human');
    expect(r.ok).toBe(true);
    expect(gw.origins[gw.origins.length - 1]).toBe('human');
  });

  it('cbGoBack dispatched with origin=ai records ai in origins', () => {
    // Ensure there is a path to go back from
    gw.dispatch({ kind: 'setCBPath', path: '/for-back' }, 'human');

    const r = gw.dispatch({ kind: 'cbGoBack' }, 'ai');
    expect(r.ok).toBe(true);
    expect(gw.origins[gw.origins.length - 1]).toBe('ai');
  });

  it('cbGoForward dispatched with origin=human records human in origins', () => {
    gw.dispatch({ kind: 'setCBPath', path: '/for-fwd' }, 'human');
    gw.dispatch({ kind: 'cbGoBack' }, 'ai');

    const r = gw.dispatch({ kind: 'cbGoForward' }, 'human');
    expect(r.ok).toBe(true);
    expect(gw.origins[gw.origins.length - 1]).toBe('human');
  });
});
