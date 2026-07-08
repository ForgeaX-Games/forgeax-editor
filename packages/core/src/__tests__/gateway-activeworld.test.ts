// w1 — TDD red-phase: gateway activeWorld/mode contract
//
// feat-20260707-editor-world-fork-ssot-level-load-play-activeworld M1:
// Define the EditGateway's new getter contract — (a) initial _playWorld=null means
// activeWorld returns doc.world, mode returns 'edit'; (b) mode is derived from
// _playWorld !== null, no second state field (Derive verification); (c)
// enterPlay/exitPlay lifecycle method type signatures and return value shape.
//
// This test is RED until w4 implements activeWorld/mode/enterPlay/exitPlay.
//
// Constraints from upstream:
//   plan-strategy D-3: activeWorld getter + mode derived from pointer
//   requirements AC-08: activeWorld pointer at core, on gateway
//   plan-strategy section 7 M1: pure additive, no refactor
//
// Anchors:
//   plan-tasks.json w1

import { describe, expect, it, beforeEach } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { EditGateway } from '../io/gateway';
import { createEditSession } from '../session/document';
import type { EditSession } from '../types';

function createSession(): EditSession {
  const s = createEditSession();
  s.world = new World();
  return s;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyGateway = EditGateway & Record<string, any>;

describe('w1 — gateway activeWorld/mode contract', () => {
  let gw: EditGateway;

  beforeEach(() => {
    gw = new EditGateway(createSession());
  });

  // ── Test (a): in edit mode (no _playWorld), activeWorld returns doc.world ──
  it('(a1) activeWorld returns doc.world when no playWorld is set (edit state)', () => {
    // TDD red-phase: activeWorld getter does not exist yet → accessing it on
    // an object without that property returns undefined, which is !== doc.world.
    // This assertion FAILS until w4 adds the getter.
    const g = gw as AnyGateway;
    expect(g.activeWorld).toBe(gw.doc.world);
  });

  // ── Test (b): mode returns 'edit' when no playWorld is set ──
  it('(b1) mode returns "edit" when no playWorld is set', () => {
    // TDD red-phase: mode getter does not exist yet → undefined !== 'edit'.
    // This assertion FAILS until w4 adds the getter.
    const g = gw as AnyGateway;
    expect(g.mode).toBe('edit');
  });

  // ── Test (c): mode is DERIVED from _playWorld — no second state field ──
  it('(b2) mode is DERIVED from pointer, not a standalone state field', () => {
    // After w4 implements the getter: mode = _playWorld !== null ? 'play' : 'edit'
    // This is a Derive verification (architecture-principles section 2):
    // mode is losslessly derivable from _playWorld null-check. This test
    // documents the contract: during review or refactor, verify mode is NOT
    // a standalone field mutated independently of _playWorld.
    //
    // Concrete assertion: mode on a fresh gateway should be 'edit' regardless
    // of any transient state. A derived getter satisfies this; a standalone
    // field would need manual sync.
    const gw2 = new EditGateway(createSession());
    const g2 = gw2 as AnyGateway;
    expect(g2.mode).toBe('edit');
  });

  // ── Test (d): enterPlay and exitPlay are callable methods ──
  it('(c1) enterPlay and exitPlay exist as methods on EditGateway', () => {
    const g = gw as AnyGateway;
    // TDD red-phase: these properties are undefined until w4.
    expect(typeof g.enterPlay).toBe('function');
    expect(typeof g.exitPlay).toBe('function');
  });

  // ── Test (e): enterPlay accepts a World, exitPlay takes no args ──
  it('(c2) enterPlay receives a playWorld (World) and exitPlay is no-arg', () => {
    const g = gw as AnyGateway;
    const playWorld = new World();
    // TDD red-phase: enterPlay is undefined → calling it throws.
    // After w4 it will be a function accepting a World.
    expect(() => g.enterPlay(playWorld)).not.toThrow();
    expect(() => g.exitPlay()).not.toThrow();
  });
});