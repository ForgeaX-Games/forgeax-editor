// w2 — TDD: enterPlay/exitPlay lifecycle
//
// feat-20260707-editor-world-fork-ssot-level-load-play-activeworld M1:
// Define enterPlay(playWorld)/exitPlay() behavior contract —
// (a) enterPlay sets _playWorld → activeWorld becomes playWorld, mode 'play';
// (b) exitPlay sets _playWorld to null → activeWorld returns to editWorld, mode 'edit';
// (c) enterPlay/exitPlay each clear selection (directly clear selection store +
//     emit, not via dispatch — this is lifecycle semantics not an edit op);
// (d) enterPlay/exitPlay each emit one notification (panels can subscribe to repull).
//
// Constraints from upstream:
//   plan-strategy D-3: switching via gateway.enterPlay/exitPlay
//   plan-strategy D-11: selection clear directly (not via dispatch)
//   requirements section 8: handle does NOT cross play/stop boundary
//
// Anchors:
//   plan-tasks.json w2

import { describe, expect, it, beforeEach } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { EditGateway } from '../io/gateway';
import { createEditSession } from '../session/document';
import type { EditSession } from '../types';
import { getSelection, getSelectionList } from '../store/selection';

// Side-effect import for selection applier registration
import '../store/selection';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyGateway = EditGateway & Record<string, any>;

function createSession(): EditSession {
  const s = createEditSession();
  s.world = new World();
  return s;
}

describe('w2 — enterPlay/exitPlay lifecycle', () => {
  let gw: EditGateway;

  beforeEach(() => {
    gw = new EditGateway(createSession());
  });

  // ── Test (a): enterPlay sets playWorld, activeWorld switches to playWorld ──
  it('(a1) enterPlay sets playWorld → activeWorld becomes playWorld', () => {
    const playWorld = new World();
    const g = gw as AnyGateway;

    g.enterPlay(playWorld);
    expect(g.activeWorld).toBe(playWorld);
  });

  // ── Test (a2): mode switches to "play" after enterPlay ──
  it('(a2) mode becomes "play" after enterPlay', () => {
    const playWorld = new World();
    const g = gw as AnyGateway;

    g.enterPlay(playWorld);
    expect(g.mode).toBe('play');
  });

  // ── Test (b): exitPlay nulls _playWorld, activeWorld returns to doc.world ──
  it('(b1) exitPlay nulls _playWorld → activeWorld returns to doc.world, mode "edit"', () => {
    const playWorld = new World();
    const g = gw as AnyGateway;

    g.enterPlay(playWorld);
    g.exitPlay();

    expect(g.activeWorld).toBe(gw.doc.world);
    expect(g.mode).toBe('edit');
  });

  // ── Test (c1): enterPlay clears selection ──
  it('(c1) enterPlay clears selection — lifecycle semantics, not an edit op', () => {
    const g = gw as AnyGateway;

    const playWorld = new World();
    g.enterPlay(playWorld);

    const sel = getSelection();
    expect(sel).toBeNull();
    expect([...getSelectionList()]).toEqual([]);
  });

  // ── Test (c2): exitPlay clears selection ──
  it('(c2) exitPlay clears selection — returning to edit mode', () => {
    const g = gw as AnyGateway;

    const playWorld = new World();
    g.enterPlay(playWorld);
    g.exitPlay();

    const sel = getSelection();
    expect(sel).toBeNull();
    expect([...getSelectionList()]).toEqual([]);
  });

  // ── Test (d): enterPlay/exitPlay each emit one notification ──
  it('(d1) enterPlay and exitPlay each emit one notification to listeners', () => {
    const g = gw as AnyGateway;
    let notifyCount = 0;

    const unsub = gw.subscribe(() => { notifyCount++; });

    const playWorld = new World();

    notifyCount = 0;
    g.enterPlay(playWorld);
    expect(notifyCount).toBe(1);

    notifyCount = 0;
    g.exitPlay();
    expect(notifyCount).toBe(1);

    unsub();
  });

  // ── Test (e): play→stop→play cycle — pointer toggle integrity ──
  it('(e1) repeated enterPlay/exitPlay cycles correctly toggle activeWorld', () => {
    const g = gw as AnyGateway;
    const w1 = new World();
    const w2 = new World();

    // First cycle
    g.enterPlay(w1);
    expect(g.activeWorld).toBe(w1);
    expect(g.mode).toBe('play');
    g.exitPlay();
    expect(g.activeWorld).toBe(gw.doc.world);
    expect(g.mode).toBe('edit');

    // Second cycle with a different world
    g.enterPlay(w2);
    expect(g.activeWorld).toBe(w2);
    expect(g.mode).toBe('play');
    g.exitPlay();
    expect(g.activeWorld).toBe(gw.doc.world);
    expect(g.mode).toBe('edit');
  });
});
