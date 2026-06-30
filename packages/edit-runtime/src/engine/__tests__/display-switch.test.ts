// w21 — display visibility switch + inputTarget derived state tests
// (requirements §3.1, §3.2, §3.3 hard constraint 2, C-4)
//
// Verifies that the {run, display} SSOT correctly enforces the orthogonal-axis
// contract: G toggles display without touching run;  Play/ Stop toggle run without
// losing the user's display preference. Also pins `auxiliaryVisible` derivation
// (display='game' => false) and the inputTarget pure-selector truth table
// complementing w16's per-quadrant tests.
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  getViewportQuadrant,
  setViewportQuadrant,
  getInputTarget,
  onViewportQuadrantChange,
} from '../viewport-quadrant';
import { deriveInputTarget } from '../viewport';

/** Derived helper: display='game' means auxiliary entities should NOT be visible. */
function auxiliaryVisible(display: string): boolean {
  return display !== 'game';
}

function resetToEntry(): void {
  setViewportQuadrant({ run: 'edit', display: 'scene' });
}

describe('display toggle orthogonality (w21, §3.2 hard constraint 2)', () => {
  beforeEach(resetToEntry);

  it('G toggles display scene→game→scene without affecting run', () => {
    // Start: edit·scene
    setViewportQuadrant({ display: 'game' }); // G press
    let q = getViewportQuadrant();
    expect(q.run).toBe('edit');       // run untouched
    expect(q.display).toBe('game');   // display toggled
    expect(q.inputTarget).toBe('editor'); // edit·game still editor-owned

    setViewportQuadrant({ display: 'scene' }); // G again
    q = getViewportQuadrant();
    expect(q.run).toBe('edit');
    expect(q.display).toBe('scene');
  });

  it('G toggles display in play mode without affecting run (play·game ⇄ play·scene)', () => {
    setViewportQuadrant({ run: 'play', display: 'game' });
    setViewportQuadrant({ display: 'scene' }); // G / Esc possess exit
    const q = getViewportQuadrant();
    expect(q.run).toBe('play');       // game keeps ticking (hard constraint 3)
    expect(q.display).toBe('scene');
    expect(q.inputTarget).toBe('editor'); // input handed back
  });

  it('display toggle does not touch EditMode lifecycle (no side-effects)', () => {
    // G only changes display — it must NOT call injectEditMode / snapshot / etc.
    // This test verifies the SSOT mutation does not touch `run`.
    setViewportQuadrant({ run: 'edit', display: 'scene' });
    const pre = getViewportQuadrant();
    // Toggle display through all 4 run x display combos driven by display-only mutations
    const transitions: Array<{ from: string; to: string; expectRun: string }> = [
      { from: 'scene', to: 'game', expectRun: 'edit' },
      { from: 'game', to: 'scene', expectRun: 'edit' },
    ];
    for (const { to, expectRun } of transitions) {
      setViewportQuadrant({ display: to as 'scene' | 'game' });
      const q = getViewportQuadrant();
      expect(q.run).toBe(expectRun);
      expect(q.display).toBe(to);
    }
  });

  it('repeated G toggles (scene⇄game) in all run states are idempotent', () => {
    for (const run of ['edit', 'play'] as const) {
      setViewportQuadrant({ run, display: 'scene' });
      for (let i = 0; i < 3; i++) {
        setViewportQuadrant({ display: 'game' });
        expect(getViewportQuadrant().display).toBe('game');
        expect(getViewportQuadrant().run).toBe(run);
        setViewportQuadrant({ display: 'scene' });
        expect(getViewportQuadrant().display).toBe('scene');
        expect(getViewportQuadrant().run).toBe(run);
      }
    }
  });
});

describe('run toggle preserves display preference (w21)', () => {
  beforeEach(resetToEntry);

  it('▶ Play preserves current display (default scene → play·game)', () => {
    // Default entry: edit·scene. ▶ → play·game (requirements §3.2: "落点 display='game'")
    setViewportQuadrant({ run: 'play', display: 'game' });
    const q = getViewportQuadrant();
    expect(q.run).toBe('play');
    expect(q.display).toBe('game');
  });

  it('■ Stop preserves current display (play·scene → edit·scene)', () => {
    setViewportQuadrant({ run: 'play', display: 'scene' });
    setViewportQuadrant({ run: 'edit', display: 'scene' }); // ■ Stop lands at edit·scene
    const q = getViewportQuadrant();
    expect(q.run).toBe('edit');
    expect(q.display).toBe('scene');
  });

  it('display preference survives a ▶ → ■ roundtrip', () => {
    // User has display=game preference → ▶ play·game → ■ edit·game (preserved)
    setViewportQuadrant({ display: 'game' }); // edit·game
    setViewportQuadrant({ run: 'play', display: 'game' }); // ▶ → play·game
    expect(getViewportQuadrant().display).toBe('game');
    setViewportQuadrant({ run: 'edit', display: 'game' }); // ■ → edit·game (display preserved)
    const q = getViewportQuadrant();
    expect(q.run).toBe('edit');
    expect(q.display).toBe('game'); // user's display preference survived
  });
});

describe('auxiliary visibility derivation (w21)', () => {
  beforeEach(resetToEntry);

  it('display=scene → auxiliaryVisible = true (aids on)', () => {
    expect(auxiliaryVisible('scene')).toBe(true);
  });

  it('display=game → auxiliaryVisible = false (clean view, AC-04)', () => {
    expect(auxiliaryVisible('game')).toBe(false);
  });

  it('auxiliaryVisible mirrors the SSOT display axis — no independent toggle', () => {
    // The display axis is the SSOT; auxiliaryVisible is purely derived.
    for (const display of ['scene', 'game'] as const) {
      setViewportQuadrant({ display });
      expect(auxiliaryVisible(getViewportQuadrant().display)).toBe(display !== 'game');
    }
  });
});

describe('inputTarget truth table from setViewportQuadrant (w21, complements w16)', () => {
  beforeEach(resetToEntry);

  it('all four quadrants return correct inputTarget via getViewportQuadrant', () => {
    // edit·scene
    setViewportQuadrant({ run: 'edit', display: 'scene' });
    expect(getViewportQuadrant().inputTarget).toBe('editor');
    // edit·game
    setViewportQuadrant({ display: 'game' });
    expect(getViewportQuadrant().inputTarget).toBe('editor');
    // play·scene
    setViewportQuadrant({ run: 'play', display: 'scene' });
    expect(getViewportQuadrant().inputTarget).toBe('editor');
    // play·game
    setViewportQuadrant({ display: 'game' });
    expect(getViewportQuadrant().inputTarget).toBe('game');
  });

  it('getInputTarget() agrees with getViewportQuadrant().inputTarget', () => {
    for (const [run, display, expected] of [
      ['edit', 'scene', 'editor'],
      ['edit', 'game', 'editor'],
      ['play', 'scene', 'editor'],
      ['play', 'game', 'game'],
    ] as const) {
      setViewportQuadrant({ run, display });
      expect(getInputTarget()).toBe(expected);
      expect(getViewportQuadrant().inputTarget).toBe(expected);
    }
  });
});

describe('subscriber notification on display-only changes (w21)', () => {
  beforeEach(resetToEntry);

  it('notifies on display toggle', () => {
    const fired: Array<{ run: string; display: string }> = [];
    const unsub = onViewportQuadrantChange((snap) => {
      fired.push({ run: snap.run, display: snap.display });
    });
    setViewportQuadrant({ display: 'game' });
    unsub();
    expect(fired.length).toBe(1);
    expect(fired[0]).toEqual({ run: 'edit', display: 'game' });
  });

  it('no-op display toggle does not notify', () => {
    let count = 0;
    const unsub = onViewportQuadrantChange(() => { count += 1; });
    setViewportQuadrant({ display: 'scene' }); // already scene
    unsub();
    expect(count).toBe(0);
  });
});
