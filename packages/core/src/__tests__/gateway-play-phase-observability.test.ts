// gateway-play-phase-observability.test.ts — solo round-8 friction #3.
//
// ▶ Play assembly is ASYNC + fire-and-forget: `dispatch({kind:'play'})` returns
// {ok:true} synchronously while run-lifecycle.playSimulation() spins up a fresh
// world in a detached promise that CAN fail and degrade back to edit. Before this
// fix the ONLY front-door signal was `mode`, which stays 'edit' on failure — so an
// AI polling `mode` could not tell "still assembling" from "already failed, will
// never flip". Rounds 3 & 5 both misdiagnosed exactly that (round 5 escalated a
// non-bug). This test pins the terminal-aware `playPhase` + `lastPlayError`
// contract that makes the failure observable through the door.
//
// The failure COUNTERPART to enterPlay's success path:
//   beginPlayAttempt() → playPhase 'starting'
//   failPlayAttempt(e) → playPhase 'failed' + lastPlayError=e, mode still 'edit'
//   enterPlay(w)       → playPhase 'play', clears pending + error
//   exitPlay()         → playPhase 'edit', clears pending + error
//
// playPhase is DERIVED from (_playWorld, _playPending, _lastPlayError) — no second
// `mode` field (architecture-principles §2 Derive).
//
// Anchors: solo round-8 report friction #3; DESIGN.md §fix-priority ladder.

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

describe('gateway play-phase observability (round-8 #3)', () => {
  let gw: EditGateway;

  beforeEach(() => {
    gw = new EditGateway(createSession());
  });

  it('(a) fresh gateway: playPhase="edit", lastPlayError=null', () => {
    expect(gw.playPhase).toBe('edit');
    expect(gw.lastPlayError).toBeNull();
    expect(gw.mode).toBe('edit'); // unchanged sibling
  });

  it('(b) beginPlayAttempt → playPhase="starting", mode stays "edit"', () => {
    gw.beginPlayAttempt();
    expect(gw.playPhase).toBe('starting');
    expect(gw.mode).toBe('edit'); // pointer not switched yet
    expect(gw.lastPlayError).toBeNull();
  });

  it('(c) failPlayAttempt → playPhase="failed", lastPlayError carries why, mode still "edit"', () => {
    gw.beginPlayAttempt();
    gw.failPlayAttempt({ code: 'play-assemble-failed', hint: 'bad scene' });
    expect(gw.playPhase).toBe('failed');
    expect(gw.mode).toBe('edit'); // degraded back to edit — the round-3/5 trap made observable
    expect(gw.lastPlayError).toEqual({ code: 'play-assemble-failed', hint: 'bad scene' });
  });

  it('(d) enterPlay after a failed attempt → playPhase="play", error cleared', () => {
    gw.beginPlayAttempt();
    gw.failPlayAttempt({ code: 'play-assemble-failed', hint: 'first try failed' });
    gw.enterPlay(new World());
    expect(gw.playPhase).toBe('play');
    expect(gw.mode).toBe('play');
    expect(gw.lastPlayError).toBeNull();
  });

  it('(e) beginPlayAttempt clears a stale error (retry starts clean)', () => {
    gw.failPlayAttempt({ code: 'play-assemble-failed', hint: 'first fail' });
    expect(gw.playPhase).toBe('failed');
    gw.beginPlayAttempt(); // retry
    expect(gw.playPhase).toBe('starting');
    expect(gw.lastPlayError).toBeNull();
  });

  it('(f) exitPlay resets to "edit" and clears pending+error', () => {
    gw.enterPlay(new World());
    expect(gw.playPhase).toBe('play');
    gw.exitPlay();
    expect(gw.playPhase).toBe('edit');
    expect(gw.mode).toBe('edit');
    expect(gw.lastPlayError).toBeNull();
  });

  it('(g) playPhase is DERIVED — play pointer wins over a stale pending flag', () => {
    // Even if a pending flag lingered, a live _playWorld means we ARE playing.
    // enterPlay clears pending anyway, but this documents the derive precedence.
    gw.beginPlayAttempt();
    gw.enterPlay(new World());
    expect(gw.playPhase).toBe('play');
  });
});
