import { describe, expect, it } from 'bun:test';
import { candidateGameRoots } from '../host-session';

describe('host-session game filesystem candidates', () => {
  it('tries the health path before appending a host-relative game root', () => {
    expect(candidateGameRoots('/workspace/games/sample', 'sample')).toEqual([
      '/workspace/games/sample',
      '/workspace/games/sample/sample',
    ]);
  });

  it('supports a health path that is the instance parent', () => {
    expect(candidateGameRoots('/workspace/games', 'sample')).toEqual([
      '/workspace/games',
      '/workspace/games/sample',
    ]);
  });

  it('does not append an empty game root', () => {
    expect(candidateGameRoots('/workspace/games/sample', '')).toEqual([
      '/workspace/games/sample',
    ]);
  });
});
