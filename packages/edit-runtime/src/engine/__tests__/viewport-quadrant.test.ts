// w20 — quadrant transition + possess-exit semantics (requirements §3.2/§3.3).
//
// The {run, display} SSOT must (a) derive inputTarget purely (C-4), (b) let the
// possess exit move ONLY the display axis (play·game → play·scene leaves run
// untouched so the game keeps ticking — §3.3 hard constraint 3), and (c) notify
// subscribers on change. The module holds process-global state, so each test
// resets to the default entry quadrant (edit·scene, AC-03) first.
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  getViewportQuadrant,
  setViewportQuadrant,
  getInputTarget,
  onViewportQuadrantChange,
} from '../viewport-quadrant';

function resetToEntry(): void {
  // Drive back to the default entry state (edit·scene) before each test.
  setViewportQuadrant({ run: 'edit', display: 'scene' });
}

describe('viewport-quadrant SSOT (w19/w20)', () => {
  beforeEach(resetToEntry);

  it('default entry quadrant is edit·scene with editor input (AC-03)', () => {
    const q = getViewportQuadrant();
    expect(q.run).toBe('edit');
    expect(q.display).toBe('scene');
    expect(q.inputTarget).toBe('editor');
  });

  it('inputTarget derives — only play·game owns game input (C-4)', () => {
    setViewportQuadrant({ run: 'play', display: 'game' });
    expect(getViewportQuadrant().inputTarget).toBe('game');
    expect(getInputTarget()).toBe('game');
    setViewportQuadrant({ display: 'scene' }); // play·scene
    expect(getViewportQuadrant().inputTarget).toBe('editor');
  });
});

describe('possess exit: play·game → play·scene (w20, §3.2 + §3.3)', () => {
  beforeEach(resetToEntry);

  it('un-possess moves ONLY display — run stays play (game keeps ticking)', () => {
    setViewportQuadrant({ run: 'play', display: 'game' });
    // Esc / G fallback both perform this single mutation:
    setViewportQuadrant({ display: 'scene' });
    const q = getViewportQuadrant();
    expect(q.run).toBe('play'); // run UNCHANGED — no Stop, EditMode/world continuous
    expect(q.display).toBe('scene'); // now Simulate (play·scene)
    expect(q.inputTarget).toBe('editor'); // input handed back to the editor
  });

  it('notifies subscribers on the possess-exit transition', () => {
    setViewportQuadrant({ run: 'play', display: 'game' });
    const fired: Array<{ run: string; display: string }> = [];
    const unsub = onViewportQuadrantChange((snap) => { fired.push({ run: snap.run, display: snap.display }); });
    setViewportQuadrant({ display: 'scene' });
    unsub();
    expect(fired).toEqual([{ run: 'play', display: 'scene' }]);
  });

  it('a no-op set (same run+display) does not notify', () => {
    setViewportQuadrant({ run: 'play', display: 'game' });
    let count = 0;
    const unsub = onViewportQuadrantChange(() => { count += 1; });
    setViewportQuadrant({ run: 'play', display: 'game' }); // identical — no change
    unsub();
    expect(count).toBe(0);
  });
});
