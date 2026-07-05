// w16 — inputTarget pure-selector unit test (requirements C-4, §3 hard constraint).
//
// `inputTarget` is a DERIVED quantity, never an independent state field. The single
// rule (requirements §3): only `(run==='play' ∧ display==='game')` routes input to
// the game; the other three quadrants route input to the editor. This test pins the
// truth table for all four quadrants and guards the "pure derivation, no setter"
// contract — the only state SSOT is {run, display}, inputTarget falls out of it.
import { describe, it, expect } from 'bun:test';
import { deriveInputTarget } from '../viewport';
import * as viewportModule from '../viewport';

describe('deriveInputTarget — 4-quadrant truth table (w16, C-4)', () => {
  it('edit·scene → editor (logic stopped, aids on, editor input)', () => {
    expect(deriveInputTarget('edit', 'scene')).toBe('editor');
  });

  it('edit·game → editor (pure framing, logic stopped, editor still orbits)', () => {
    expect(deriveInputTarget('edit', 'game')).toBe('editor');
  });

  it('play·scene → editor (Simulate observe: free-look / pick / param-edit)', () => {
    expect(deriveInputTarget('play', 'scene')).toBe('editor');
  });

  it('play·game → game (PIE: character possessed, the ONLY game-input quadrant)', () => {
    expect(deriveInputTarget('play', 'game')).toBe('game');
  });
});

describe('deriveInputTarget — purity contract (C-4: no independent state field)', () => {
  it('is a pure function — same inputs always give same output, no hidden state', () => {
    // Call repeatedly across all quadrants; result depends only on args.
    for (let i = 0; i < 3; i++) {
      expect(deriveInputTarget('play', 'game')).toBe('game');
      expect(deriveInputTarget('edit', 'scene')).toBe('editor');
    }
  });

  it('exposes NO setInputTarget — inputTarget is derived, never written', () => {
    // The selector is the only inputTarget entry point. A `setInputTarget` export
    // would mean inputTarget became an independent state field (C-4 violation).
    expect((viewportModule as Record<string, unknown>).setInputTarget).toBeUndefined();
  });
});
