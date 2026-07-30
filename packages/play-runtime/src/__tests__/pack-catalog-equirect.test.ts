/// <reference types="bun" />

// Regression guard for the skybox-not-rendering bug: an `.hdr` sidecar whose
// sub-asset declares kind:'equirect' (feat-20260630 internalized IBL) must fold
// to a kind:'equirect' catalog row backed by a cooked Pack v2 URL — never a
// raw `.hdr` locator, which assets-runtime rejects before attempting a load.
//
// Root cause this pins: bakeHdrEquirect's importer ctx requested kind:'image',
// but the migrated image-importer `.hdr` arm folds ONLY kind:'equirect'
// sub-assets, so every HDR bake produced nothing ("importer produced no asset"),
// fell through to the raw row, and the preview viewport went to clear-color.
//
// Uses a real sky.hdr baked into a temp dir. When no sky.hdr fixture is present
// (fresh editor clone without the assets submodule initialized) the suite skips
// rather than fails — matching the build-repo pack-catalog test convention.

import { describe, it, expect, beforeAll } from 'bun:test';
import { resolve } from 'node:path';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { buildPerGameCatalog } from '../../pack-catalog';

// Candidate sky.hdr locations, most-standalone first.
const HERE = import.meta.dirname!;
const CANDIDATES = [
  // editor assets submodule (present after submodule update --init)
  resolve(HERE, '..', '..', '..', '..', 'forgeax-editor-assets', 'template-game-default', 'sky.hdr'),
  // studio context: the shared game library
  resolve(HERE, '..', '..', '..', '..', '..', '..', '.forgeax', 'games', 'hellforge', 'assets', 'sky.hdr'),
];
const SKY_HDR = CANDIDATES.find((p) => existsSync(p));
const skip = SKY_HDR === undefined;

const SKY_GUID = '81eec382-392f-5a93-8998-0ecf11ef7990';

describe('pack-catalog equirect Pack v2 navigation', () => {
  let tmpDir: string | null = null;
  let entries: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    if (skip) return;
    tmpDir = mkdtempSync(resolve(tmpdir(), 'fx-pr-equirect-'));
    copyFileSync(SKY_HDR!, resolve(tmpDir, 'sky.hdr'));
    writeFileSync(
      resolve(tmpDir, 'sky.hdr.meta.json'),
      JSON.stringify({
        kind: 'external-asset-package',
        importer: 'image',
        schemaVersion: '1.0.0',
        source: 'sky.hdr',
        importSettings: { colorSpace: 'linear', mipmap: 'auto' },
        subAssets: [{ guid: SKY_GUID, sourceIndex: 0, kind: 'equirect' }],
      }),
    );
    entries = (await buildPerGameCatalog(tmpDir, '')) as unknown as Array<Record<string, unknown>>;
  });

  it.skipIf(skip)('emits a kind:equirect row for the equirect sub-asset', () => {
    const row = entries.find((e) => e.guid === SKY_GUID);
    expect(row, 'equirect sub-asset must produce a catalog row').toBeDefined();
    expect(row!.kind).toBe('equirect');
  });

  it.skipIf(skip)('row points at the cooked Pack v2 package', () => {
    const row = entries.find((e) => e.guid === SKY_GUID)!;
    expect(row.packageUrl, 'must point at a cooked package, not the raw .hdr').toBe(
      `/__forgeax-ddc/${SKY_GUID}.pack.json`,
    );
    expect(row.metadata).toBeUndefined();
  });

  it.skipIf(skip)('cleanup temp dir', () => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });
});
