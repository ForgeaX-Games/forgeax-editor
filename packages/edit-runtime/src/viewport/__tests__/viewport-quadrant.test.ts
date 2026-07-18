// Explicit viewport input ownership: run, display and control are separate facts.
import { beforeEach, describe, expect, it } from 'bun:test';
import {
  getInputTarget,
  getViewportQuadrant,
  onViewportQuadrantChange,
  setViewportQuadrant,
} from '../viewport-quadrant';

function resetToEntry(): void {
  setViewportQuadrant({ run: 'edit', display: 'scene', control: 'editor' });
}

describe('viewport-quadrant explicit control lease', () => {
  beforeEach(resetToEntry);

  it('opens in edit scene with editor control', () => {
    expect(getViewportQuadrant()).toMatchObject({
      run: 'edit', display: 'scene', control: 'editor', inputTarget: 'editor',
    });
  });

  it('Play game view stays uncontrolled until the host grants game control', () => {
    setViewportQuadrant({ run: 'play', display: 'game' });
    expect(getViewportQuadrant()).toMatchObject({ control: 'editor', inputTarget: 'editor' });

    setViewportQuadrant({ control: 'game' });
    expect(getInputTarget()).toBe('game');
  });

  it('revocation preserves run and display while returning input to editor', () => {
    setViewportQuadrant({ run: 'play', display: 'game', control: 'game' });
    setViewportQuadrant({ control: 'editor' });
    expect(getViewportQuadrant()).toMatchObject({
      run: 'play', display: 'game', control: 'editor', inputTarget: 'editor',
    });
  });

  it('display exit or Stop structurally revokes game control', () => {
    setViewportQuadrant({ run: 'play', display: 'game', control: 'game' });
    setViewportQuadrant({ display: 'scene' });
    expect(getViewportQuadrant()).toMatchObject({ control: 'editor', inputTarget: 'editor' });

    setViewportQuadrant({ display: 'game', control: 'game' });
    setViewportQuadrant({ run: 'edit' });
    expect(getViewportQuadrant()).toMatchObject({ control: 'editor', inputTarget: 'editor' });
  });

  it('notifies subscribers only for fact transitions', () => {
    const fired: Array<{ run: string; display: string; control: string }> = [];
    const unsub = onViewportQuadrantChange((q) => fired.push({ run: q.run, display: q.display, control: q.control }));
    setViewportQuadrant({ run: 'play', display: 'game' });
    setViewportQuadrant({ control: 'game' });
    setViewportQuadrant({ control: 'game' });
    unsub();
    expect(fired).toEqual([
      { run: 'play', display: 'game', control: 'editor' },
      { run: 'play', display: 'game', control: 'game' },
    ]);
  });
});
