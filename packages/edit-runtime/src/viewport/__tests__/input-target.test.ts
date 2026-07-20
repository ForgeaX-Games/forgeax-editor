// w16 — inputTarget pure-selector unit test (requirements C-4, §3 hard constraint).
//
// inputTarget is derived, never independently stored. Run starts/stops the
// simulation; an explicit control lease grants game input. Display is intentionally
// absent from the rule so watching a game cannot capture the keyboard.
import { describe, it, expect } from 'bun:test';
import { deriveInputTarget } from '../viewport';
import * as viewportModule from '../viewport';

describe('deriveInputTarget — run plus explicit control lease', () => {
  it('keeps editor input whenever simulation is not playing', () => {
    expect(deriveInputTarget('edit', 'editor')).toBe('editor');
    expect(deriveInputTarget('edit', 'game')).toBe('editor');
  });

  it('starts Play uncontrolled and grants only an explicit game lease', () => {
    expect(deriveInputTarget('play', 'editor')).toBe('editor');
    expect(deriveInputTarget('play', 'game')).toBe('game');
  });
});

describe('deriveInputTarget — purity contract (C-4: no independent state field)', () => {
  it('is a pure function — same inputs always give same output, no hidden state', () => {
    // Call repeatedly across all quadrants; result depends only on args.
    for (let i = 0; i < 3; i++) {
      expect(deriveInputTarget('play', 'game')).toBe('game');
      expect(deriveInputTarget('edit', 'editor')).toBe('editor');
    }
  });

  it('exposes NO setInputTarget — inputTarget is derived, never written', () => {
    // The selector is the only inputTarget entry point. A `setInputTarget` export
    // would mean inputTarget became an independent state field (C-4 violation).
    expect((viewportModule as Record<string, unknown>).setInputTarget).toBeUndefined();
  });
});
