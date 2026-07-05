// epoch-guard.test.ts (w8) — run-generation epoch guard unit test.
//
// Covers the D-1c layer-2 undo channel for ctx.registerUpdate: ■ Stop bumps the
// run epoch so callbacks registered in a prior run generation short-circuit to
// no-op (the engine frame loop has addUpdateCallback but no remove API).
//
// Four scenarios (plan-tasks.json w8):
//   (1) callback registered at epoch N + epoch still N -> fn runs.
//   (2) callback registered at epoch N + epoch bumped to N+1 -> fn no-op.
//   (3) epoch never bumped -> many registrations all run (same generation).
//   (4) two generations coexist -> old-gen all no-op, new-gen all run.
//
// The guard is a PURE closure over a counter — no world, no frame loop. Anchors:
//   plan-strategy D-1c ("registerUpdate wraps a run-generation epoch guard:
//     the registered fn checks `if (epoch !== currentRunEpoch) return;`")
//   requirements AC-08 / AC-09 (repeated ▶/■ accumulates no callbacks;
//     continuous run without reset)

import { describe, expect, it } from 'bun:test';
import { makeEpochGuard } from '../run-lifecycle';

describe('w8 — epoch guard (pure)', () => {
  it('(1) epoch matches capture-time -> callback runs', () => {
    const g = makeEpochGuard();
    let calls = 0;
    const wrapped = g.wrap(() => {
      calls += 1;
    });
    wrapped(0.016);
    wrapped(0.016);
    expect(calls).toBe(2);
  });

  it('(2) epoch bumped after capture -> callback no-ops', () => {
    const g = makeEpochGuard();
    let calls = 0;
    const wrapped = g.wrap(() => {
      calls += 1;
    });
    wrapped(0.016); // runs (epoch 0 == 0)
    g.bump(); // -> generation 1
    wrapped(0.016); // no-op (captured 0, current 1)
    wrapped(0.016); // no-op
    expect(calls).toBe(1);
  });

  it('(3) epoch never bumped -> all same-generation callbacks run', () => {
    const g = makeEpochGuard();
    let calls = 0;
    const a = g.wrap(() => {
      calls += 1;
    });
    const b = g.wrap(() => {
      calls += 1;
    });
    const c = g.wrap(() => {
      calls += 1;
    });
    a(0);
    b(0);
    c(0);
    expect(calls).toBe(3);
    expect(g.current()).toBe(0);
  });

  it('(4) two generations coexist -> old-gen no-op, new-gen run', () => {
    const g = makeEpochGuard();
    let oldCalls = 0;
    let newCalls = 0;
    const oldGen = g.wrap(() => {
      oldCalls += 1;
    });
    g.bump(); // -> generation 1
    const newGen = g.wrap(() => {
      newCalls += 1;
    });

    oldGen(0); // no-op (captured 0, current 1)
    newGen(0); // runs (captured 1, current 1)
    oldGen(0); // no-op
    newGen(0); // runs

    expect(oldCalls).toBe(0);
    expect(newCalls).toBe(2);
    expect(g.current()).toBe(1);
  });

  it('bump is monotonic and repeatable (idempotent stop safety)', () => {
    const g = makeEpochGuard();
    const wrapped = g.wrap(() => {
      throw new Error('should never run after bump');
    });
    g.bump();
    g.bump(); // a second ■ Stop with no ▶ in between — still safe
    expect(g.current()).toBe(2);
    expect(() => wrapped(0)).not.toThrow();
  });
});
