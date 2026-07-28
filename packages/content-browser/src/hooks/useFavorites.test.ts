import { describe, expect, it } from 'bun:test';
import { favoriteKey } from './useFavorites';

// Regression: the Assets panel writes every new material into ONE shared
// `Materials.pack.json`, so the containing file's path is not an identity for
// the assets inside it. Keying favorites on that path made a single stored
// entry light up every material in the pack plus the pack file's own card.

describe('favoriteKey — asset vs path identity', () => {
  const PACK = 'assets/Materials.pack.json';

  it('gives two assets in the SAME pack distinct keys', () => {
    const a = favoriteKey({ kind: 'asset', guid: '0198c2a1-0000-7000-8000-000000000001' });
    const b = favoriteKey({ kind: 'asset', guid: '0198c2a1-0000-7000-8000-000000000002' });
    expect(a).not.toBe(b);
  });

  it('never collides with the key of the pack file that contains the asset', () => {
    const asset = favoriteKey({ kind: 'asset', guid: '0198c2a1-0000-7000-8000-000000000001' });
    expect(asset).not.toBe(favoriteKey({ kind: 'path', path: PACK }));
  });

  it('separates the asset and path namespaces even for identical strings', () => {
    expect(favoriteKey({ kind: 'asset', guid: 'x' })).not.toBe(favoriteKey({ kind: 'path', path: 'x' }));
  });

  it('is stable for the same ref (a favorite survives re-render/reload)', () => {
    expect(favoriteKey({ kind: 'path', path: PACK })).toBe(favoriteKey({ kind: 'path', path: PACK }));
  });
});
