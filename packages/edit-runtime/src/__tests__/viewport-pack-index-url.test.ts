import { describe, expect, it } from 'bun:test';

import { resolveViewportPackIndexUrl } from '../viewport/ViewportComponent';

describe('viewport asset catalog identity', () => {
  it('uses the host game slug and never the active scene id', () => {
    expect(resolveViewportPackIndexUrl({
      gameSlug: 'game-2048', selfHostPack: false, base: '/preview',
    })).toBe('/preview/pack-index/game-2048.json');
  });

  it('preserves an explicitly injected host catalog URL', () => {
    expect(resolveViewportPackIndexUrl({
      gameSlug: 'game-2048', injectedUrl: 'https://assets.example/game.json',
      selfHostPack: false, base: '/preview',
    })).toBe('https://assets.example/game.json');
  });

  it('uses the host-local global catalog for self-hosted and empty sessions', () => {
    expect(resolveViewportPackIndexUrl({
      gameSlug: 'game-2048', selfHostPack: true, base: '/preview',
    })).toBe('/preview/pack-index.json');
    expect(resolveViewportPackIndexUrl({
      gameSlug: null, selfHostPack: false, base: '/preview',
    })).toBe('/preview/pack-index.json');
  });
});
