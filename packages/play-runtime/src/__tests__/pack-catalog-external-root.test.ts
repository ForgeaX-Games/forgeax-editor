/// <reference types="bun" />

// Regression guard for external/shared asset roots folding into the catalog.
//
// A game declares a shared root in package.json#forgeax.assets.roots as
// `@shared/characters`; play-runtime's symlink farm mounts that external scope
// UNDER the vite root (as `shared-assets/<sub>`) and folds it into the game's
// per-game catalog. This pins the property that a silent regression could break
// (current CI misses it — b2 uses a scratch game with no assets, smoke-play uses
// games/sample with no equirect): a shared root folds into buildPerGameCatalog
// with a SERVEABLE relativeUrl — one under /preview with NO leading `../` (the
// withBase posix.resolve('/',…) clamp that would mangle a naive external abs
// path into a 404). The farm is what makes relative(cwd, farmed) a clean subpath;
// this test reproduces its shape (shared scope symlinked under the scan cwd).
//
// The `@shared/<sub>` alias CLASSIFICATION (resolveGameAssetRoots) is unit-tested
// in @forgeax/editor-core (packages/core/src/__tests__/asset-roots.test.ts) — it
// lives there because play-runtime may only import editor-core via the VAG
// `/protocol` channel (lint-play-vag-boundary). This file covers the downstream
// catalog fold only, via ../../pack-catalog.
//
// Uses the real Fox.glb from the editor assets submodule (present after
// submodule update --init). Skips when absent — matches the equirect test.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { resolve, join } from 'node:path';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';

import { buildPerGameCatalog } from '../../pack-catalog';

const HERE = import.meta.dirname!;
const FOX_GLB = resolve(
  HERE, '..', '..', '..', '..', 'forgeax-editor-assets', 'characters', 'Fox.glb',
);
const FOX_META = `${FOX_GLB}.meta.json`;
const skip = !existsSync(FOX_GLB) || !existsSync(FOX_META);

// The Fox scene sub-asset GUID (pinned in Fox.glb.meta.json).
const FOX_SCENE_GUID = '019f56f2-0ac0-776a-9d28-50eb5a9edeb8';

describe('external asset roots — shared GLB folds with a serveable relativeUrl', () => {
  let tmpRoot: string | null = null;
  let entries: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    if (skip) return;
    // Reproduce the play-runtime farm shape: the shared scope is mounted UNDER
    // the scan cwd (the game dir) via a symlink, so relative(cwd, asset) is a
    // clean in-root subpath — exactly what farmPath() arranges with the
    // `shared-assets/<sub>` symlink. We scan from the game dir with the farmed
    // shared root as an extra root.
    tmpRoot = mkdtempSync(resolve(tmpdir(), 'fx-pr-extfold-'));
    const gameDir = join(tmpRoot, 'game');
    mkdirSync(join(gameDir, 'assets'), { recursive: true });
    // real shared source, OUTSIDE the game dir
    const realShared = join(tmpRoot, 'forgeax-editor-assets', 'characters');
    mkdirSync(realShared, { recursive: true });
    copyFileSync(FOX_GLB, join(realShared, 'Fox.glb'));
    copyFileSync(FOX_META, join(realShared, 'Fox.glb.meta.json'));
    // farm: symlink the shared scope under the game dir (mirrors shared-assets/<sub>)
    mkdirSync(join(gameDir, 'shared-roots'), { recursive: true });
    const farmed = join(gameDir, 'shared-roots', 'characters');
    symlinkSync(realShared, farmed, 'junction');

    // Build the catalog the way perGamePackRoots feeds it: primary = game assets,
    // extra = the farmed shared root. base '/preview' like production.
    entries = (await buildPerGameCatalog(
      join(gameDir, 'assets'),
      '/preview',
      [farmed],
    )) as unknown as Array<Record<string, unknown>>;
  });

  afterAll(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it.skipIf(skip)('folds the Fox scene sub-asset into the catalog', () => {
    const row = entries.find((e) => e.guid === FOX_SCENE_GUID);
    expect(row, 'Fox scene GUID must be catalogued from the @shared root').toBeDefined();
    expect(row!.kind).toBe('scene');
  });

  it.skipIf(skip)('every shared row has a serveable /preview relativeUrl with NO ../', () => {
    const foxRows = entries.filter((e) =>
      String((e as { relativeUrl?: string }).relativeUrl ?? '').includes('Fox.glb'),
    );
    expect(foxRows.length, 'Fox sub-assets present').toBeGreaterThan(0);
    for (const row of foxRows) {
      const url = String(row.relativeUrl);
      expect(url.startsWith('/preview/'), `served under /preview: ${url}`).toBe(true);
      expect(url.includes('../'), `no clamped ../ in URL: ${url}`).toBe(false);
    }
  });
});
