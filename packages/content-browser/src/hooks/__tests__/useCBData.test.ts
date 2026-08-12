import { describe, expect, it } from 'bun:test';
import { normalizeStoragePath } from '../useCBData';

// Regression (material-editor texture drop → HTTP 400): the engine's
// resolveCatalogAssetUrl resolves every pack-index row's packageUrl against
// packIndexUrl via `new URL(rel, base).href`, so listCatalog() surfaces FULL
// URLs (`http://127.0.0.1:15290/Forgeax-games/<slug>/assets/x.pack.json`).
// The passthrough guard used to treat that URL as a "normal relative path"
// (no `/` prefix, no drive letter, no `..`) and return it unchanged — the
// URL then flowed into CBAsset.packPath → updateMaterialParams → readPack →
// `GET /api/files?path=<URL>` → singleGameFileBackend rejects (not `<slug>/…`)
// → 400 and a silently dropped write.

describe('normalizeStoragePath — catalog address → file-backend client space', () => {
  const SLUG = 'spin-cube';

  it('reduces an origin-prefixed catalog URL to <slug>/<rel>', () => {
    expect(
      normalizeStoragePath(
        'http://127.0.0.1:15290/Forgeax-games/spin-cube/assets/base-material.pack.json',
        SLUG,
      ),
    ).toBe('spin-cube/assets/base-material.pack.json');
  });

  it('reduces a ../-escaping relative path to <slug>/<rel>', () => {
    expect(
      normalizeStoragePath('../Forgeax-games/spin-cube/assets/foo.mp3', SLUG),
    ).toBe('spin-cube/assets/foo.mp3');
  });

  it('reduces a Windows-absolute path to <slug>/<rel>', () => {
    expect(
      normalizeStoragePath('E:/ForgeaxEditor/Forgeax-games/spin-cube/assets/foo.mp3', SLUG),
    ).toBe('spin-cube/assets/foo.mp3');
  });

  it('passes an already-normal <slug>/<rel> path through unchanged', () => {
    expect(normalizeStoragePath('spin-cube/assets/foo.mp3', SLUG)).toBe('spin-cube/assets/foo.mp3');
  });

  it('canonicalizes a legacy games/<slug>/ path to standalone client space', () => {
    expect(normalizeStoragePath('games/spin-cube/assets/foo.mp3', SLUG)).toBe(
      'spin-cube/assets/foo.mp3',
    );
  });

  it('returns undefined/empty input unchanged', () => {
    expect(normalizeStoragePath(undefined, SLUG)).toBeUndefined();
    expect(normalizeStoragePath('', SLUG)).toBe('');
  });

  it('keeps an unparseable scheme-ish value on the raw fallback', () => {
    // new URL() throws → raw value flows through the legacy guards.
    const weird = 'http://';
    expect(normalizeStoragePath(weird, SLUG)).toBe(weird);
  });
});
