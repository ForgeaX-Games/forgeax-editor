import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

  it('binds the RuntimeUiGraph even when the renderer only exposes subscribe()', () => {
    const source = readFileSync(resolve(import.meta.dir, '..', 'host-session.ts'), 'utf8');
    expect(source).toContain('subscribeRendererFrameOpportunity');
    expect(source).toContain('liveWorldPublisher.bind(ctx.world)');
    expect(source).toContain('publisher: liveWorldPublisher');
    expect(source).not.toContain('canPublishFrameEnd');
  });
});
