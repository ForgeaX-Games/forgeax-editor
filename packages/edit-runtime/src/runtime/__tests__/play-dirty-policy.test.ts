import { describe, expect, it } from 'bun:test';
import { decidePlayDirtyPolicy } from '../play-dirty-policy';

describe('Play dirty authoring policy', () => {
  it('has explicit last-saved, save-then-play, and cancel branches', () => {
    expect(decidePlayDirtyPolicy({ dirty: false, choice: 'last-saved' })).toEqual({ action: 'play', source: 'last-saved' });
    expect(decidePlayDirtyPolicy({ dirty: true, choice: 'last-saved' })).toEqual({ action: 'play', source: 'last-saved' });
    expect(decidePlayDirtyPolicy({ dirty: true, choice: 'save-then-play' })).toEqual({ action: 'save-then-play', source: 'terminal-after-save' });
    expect(decidePlayDirtyPolicy({ dirty: true, choice: 'cancel' })).toEqual({ action: 'cancel' });
  });
});
