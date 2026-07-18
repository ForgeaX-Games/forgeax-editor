// M5 — TDD tests for eval channel + scope② + integration
//
// feat-20260707-editor-trace-ioc M5:
// This file accumulates M5's red-then-green test suite as tasks execute in
// topological order (t33a → t31 → t32 → t33b/t33c/t33d/t33e).
//
// RED-phase tests MUST FAIL before their corresponding impl tasks, then turn
// GREEN after the impl lands. Each describe block is labelled with the
// task that makes it green.
//
// Anchors:
//   plan-strategy §5.1 TDD: channel is forced red-green-refactor module
//   requirements AC-11: channel.eval(code) returns {ok, value} / {ok:false, error}
//   requirements AC-12: eval ≡ direct dispatch (same applier / ledger / trace)
//   requirements AC-13: structured errors: SCRIPT_SYNTAX_ERROR / SCRIPT_RUNTIME_ERROR
//   requirements AC-02: scope① = {gateway, query, _import}, no world/renderer/assets
//   requirements AC-10: eval can read trace via gateway.trace.last()
//   plan-strategy §2 D-4: scope② unlock = explicit API + host DEV flag

import { describe, expect, it, beforeEach } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-runtime';
import { EditGateway } from '../io/gateway';
import { registerApplier, sessionAppliers } from '../io/appliers';
import { createEditSession } from '../session/document';
import type { EditorOp, EditSession } from '../types';
// t33a RED: createEvalChannel does not exist yet — this import MUST fail
import { createEvalChannel } from '../io/channel';
import type { EvaluateResult, EvalChannel } from '../io/channel';

// ── Fixture helpers ──────────────────────────────────────────────────────────

function createSession(): EditSession {
  const session = createEditSession();
  session.world = new World();
  return session;
}

function spawnEntity(bus: EditGateway, name: string): number {
  const cmd: EditorOp = {
    kind: 'spawnEntity',
    name,
    components: { Transform: { pos: [0, 0, 0] } },
  };
  const r = bus.dispatch(cmd);
  if (!r.ok) throw new Error(`spawn failed: ${(r as any).error?.hint}`);
  return (cmd as any)._id!;
}

// ===========================================================================
// t33a — channel.eval API RED test (RED before t31, GREEN after t31)
// ===========================================================================
// RED phase: createEvalChannel exists (module compiled) but when called with
// a trivial script, the eval channel executes code and returns {ok, value}.
// BEFORE t31: createEvalChannel is imported as an empty stub that throws,
//            or the file doesn't exist at all → import fails → test fails.
// AFTER t31: channel.eval('return gateway.listOps()') → {ok:true, value: [...]}

describe('t33a — channel.eval API (RED before t31, GREEN after t31)', () => {
  let gw: EditGateway;
  let channel: EvalChannel;

  beforeEach(() => {
    gw = new EditGateway(createSession());
    // Stash world for query to work
    gw.doc.world = new World();
    channel = createEvalChannel(gw);
  });

  it('should evaluate a trivial expression and return ok', () => {
    // Builtin eval captures the last expression value; do NOT use `return`
    // at the top level (eval in strict-mode ESM does not allow top-level return).
    const result: EvaluateResult = channel.eval('42');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(42);
    }
  });

  it('should access gateway from scope① and return listOps', () => {
    // t31 scope① = {gateway, query, _import}
    const result: EvaluateResult = channel.eval('gateway.listOps()');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Array.isArray(result.value)).toBe(true);
    }
  });

  it('should dispatch through eval and see it in the ledger', () => {
    // Use IIFE for multi-statement scripts; last expression value is returned by eval.
    const code = `
      (() => {
        const r = gateway.dispatch({ kind: 'spawnEntity', name: 'eval-entity', components: {} }, 'ai');
        return r.ok ? 'spawned' : r.error.code;
      })()
    `;
    const result: EvaluateResult = channel.eval(code);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('spawned');
    }
    // The ledger must contain the eval-dispatched op
    expect(gw.ledger.length).toBeGreaterThanOrEqual(1);
    const last = gw.ledger[gw.ledger.length - 1];
    expect(last!.kind).toBe('spawnEntity');
  });
});

// ===========================================================================
// t33c — eval error structured test (RED before t31, GREEN after t31)
// ===========================================================================
// These tests also need createEvalChannel to exist, so they are RED too.
// They turn GREEN after t31 implements structured error handling.

describe('t33c — eval error structured (RED before t31, GREEN after t31)', () => {
  let gw: EditGateway;
  let channel: EvalChannel;

  beforeEach(() => {
    gw = new EditGateway(createSession());
    gw.doc.world = new World();
    channel = createEvalChannel(gw);
  });

  it('should return SCRIPT_SYNTAX_ERROR for parse failures (AC-13)', () => {
    const result: EvaluateResult = channel.eval('syntax error!!!!');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SCRIPT_SYNTAX_ERROR');
      expect(typeof result.error.hint).toBe('string');
      expect(result.error.hint.length).toBeGreaterThan(0);
    }
  });

  it('should return SCRIPT_RUNTIME_ERROR for thrown errors (AC-13)', () => {
    const result: EvaluateResult = channel.eval('throw new Error("boom")');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SCRIPT_RUNTIME_ERROR');
      expect(typeof result.error.hint).toBe('string');
      expect(result.error.hint.length).toBeGreaterThan(0);
    }
  });

  it('should have error.code as string for property-access consumption (charter P3)', () => {
    const result: EvaluateResult = channel.eval('throw "ugh"');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.error.code).toBe('string');
    }
  });
});

// ===========================================================================
// t33b — eval ≡ direct dispatch equivalence + trace read (AC-12, AC-10)
// GREEN after t32 (eval channel + scope② + globalThis are implemented)
// ===========================================================================

describe('t33b — eval ≡ direct dispatch equivalent + trace read', () => {
  let gw: EditGateway;
  let channel: EvalChannel;

  beforeEach(() => {
    gw = new EditGateway(createSession());
    gw.doc.world = new World();
    channel = createEvalChannel(gw);
  });

  it('should produce the same ledger entries as direct dispatch (AC-12)', () => {
    // Direct dispatch batch
    for (let i = 0; i < 3; i++) {
      gw.dispatch({
        kind: 'spawnEntity',
        name: `direct-${i}`,
        components: { Transform: { pos: [i, 0, 0] } },
      }, 'ai');
    }
    const directLedgerLen = gw.ledger.length;

    // Eval dispatch batch — same 3 spawns via eval
    const evalCode = `
      (() => {
        for (let i = 0; i < 3; i++) {
          gateway.dispatch({
            kind: 'spawnEntity',
            name: 'eval-' + i,
            components: { Transform: { pos: [i, 0, 0] } },
          }, 'ai');
        }
        return 'done';
      })()
    `;
    const evalResult = channel.eval(evalCode);
    expect(evalResult.ok).toBe(true);
    // Ledger grew by 3 more entries
    expect(gw.ledger.length).toBe(directLedgerLen + 3);
    // Both paths produce spawnEntity ops
    const evalOps = gw.ledger.slice(directLedgerLen);
    for (const op of evalOps) {
      expect((op as EditorOp).kind).toBe('spawnEntity');
    }
  });

  it('should produce trace spans from eval dispatch (AC-10, AC-12)', () => {
    // eval that dispatches → trace is produced
    const evalCode = `
      (() => {
        gateway.dispatch({ kind: 'spawnEntity', name: 'trace-test', components: {} }, 'ai');
        return 'ok';
      })()
    `;
    const evalResult = channel.eval(evalCode);
    expect(evalResult.ok).toBe(true);
    // Trace should have at least one root span
    const roots = gw.trace.recent(5);
    expect(roots.length).toBeGreaterThanOrEqual(1);
  });

  it('should allow reading trace from within eval code (AC-10)', () => {
    // Dispatch inside eval, then read trace via gateway.trace.last()
    const evalCode = `
      (() => {
        gateway.dispatch({ kind: 'spawnEntity', name: 'in-eval-trace', components: {} }, 'ai');
        const tree = gateway.trace.last();
        return tree ? tree.name : 'no-trace';
      })()
    `;
    const evalResult = channel.eval(evalCode);
    expect(evalResult.ok).toBe(true);
    if (evalResult.ok) {
      // tree.name should reflect the eval's dispatch
      expect(evalResult.value).not.toBe('no-trace');
    }
  });

  it('should return plain-object span tree from gateway.trace.last() (AC-10)', () => {
    // Produce a trace
    gw.dispatch({ kind: 'spawnEntity', name: 'span-plain', components: {} }, 'ai');
    const tree = gw.trace.last();
    expect(tree).not.toBeNull();
    if (tree) {
      expect(typeof tree.traceId).toBe('string');
      expect(typeof tree.spanId).toBe('string');
      expect(typeof tree.name).toBe('string');
      expect(Array.isArray(tree.children)).toBe(true);
    }
  });
});

// ===========================================================================
// t33d — scope② refusal test (RED before t32, GREEN after t32)
// ===========================================================================
// scope② is LOCKED by default (no rawScope injected) → unlockRawScope()
// returns {ok:false, code:'SCOPE_LOCKED'}. Also verify scope① has no world.

describe('t33d — scope② unlock refusal (AC-02)', () => {
  it('should return SCOPE_LOCKED when rawScope not injected (production default)', () => {
    const gw = new EditGateway(createSession());
    gw.doc.world = new World();
    // Create channel WITHOUT rawScope (production build behavior)
    const channel = createEvalChannel(gw);
    const result = channel.unlockRawScope();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SCOPE_LOCKED');
      expect(typeof result.error.hint).toBe('string');
      expect(result.error.hint.length).toBeGreaterThan(0);
    }
  });

  it('should allow unlockRawScope when rawScope is injected (dev build)', () => {
    const gw = new EditGateway(createSession());
    gw.doc.world = new World();
    // Create channel WITH rawScope (dev build behavior)
    const channel = createEvalChannel(gw, { rawScope: { world: gw.doc.world } });
    const result = channel.unlockRawScope();
    expect(result.ok).toBe(true);
  });

  it('should confirm scope① has no world symbol (AC-02 negative assertion)', () => {
    const gw = new EditGateway(createSession());
    gw.doc.world = new World();
    const channel = createEvalChannel(gw);
    // In scope①, `typeof world` should be 'undefined'
    const evalResult = channel.eval('typeof world');
    expect(evalResult.ok).toBe(true);
    if (evalResult.ok) {
      expect(evalResult.value).toBe('undefined');
    }
  });
});

// ===========================================================================
// t33e — eval reentry/nesting test (requirements §7 boundary)
// GREEN after t32 (channel + trace stack supports natural nesting)
// ===========================================================================

describe('t33e — eval reentry nesting (requirements §7 boundary)', () => {
  it('should not crash when eval calls eval (nested reentry)', () => {
    const gw = new EditGateway(createSession());
    gw.doc.world = new World();
    const channel = createEvalChannel(gw);

    // Inner eval returns a value; outer eval wraps and returns it
    const outerCode = `
      (() => {
        const inner = __forgeaxEval_inner.eval('42 + 1');
        return inner.ok ? inner.value : 'inner-failed';
      })()
    `;

    // Since we're in a test context (no globalThis mount), pass the channel
    // explicitly as an injected rawScope symbol
    const channelWithRef = createEvalChannel(gw, {
      rawScope: { __forgeaxEval_inner: channel },
    });

    const result = channelWithRef.eval(outerCode);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(43);
    }
  });

  it('should not crash when eval dispatches a transaction with nested ops', () => {
    const gw = new EditGateway(createSession());
    gw.doc.world = new World();
    const channel = createEvalChannel(gw);

    // Dispatch through eval: a transaction spawns two entities
    const evalCode = `
      (() => {
        const r = gateway.dispatch({
          kind: 'transaction',
          label: 'eval-tx',
          commands: [
            { kind: 'spawnEntity', name: 'tx-a', components: {} },
            { kind: 'spawnEntity', name: 'tx-b', components: {} },
          ],
        }, 'ai');
        return r.ok ? 'tx-ok' : r.error.code;
      })()
    `;
    const result = channel.eval(evalCode);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('tx-ok');
    }
    expect(gw.ledger.length).toBeGreaterThanOrEqual(1);
  });
});