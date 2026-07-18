// save-inline-materials.test.ts — regression guard for the editor save bug that
// dropped inline material bodies from scene.pack.json.
//
// Root cause: serializeSceneAssetToPack (engine) emits ONLY the `scene` asset;
// every shared ref (material GUID) becomes a refs[] string but the referenced
// asset BODY is never written back. For inline materials — whose payload lives
// inside THIS scene.pack — that silently drops the payload, so on reload the
// pack-index points the GUID back at scene.pack.json, finds no matching entry,
// and MeshRenderer falls back to default grey ("add-to-scene → scene turned
// grey" data loss). worldToPack now re-appends inline asset bodies via
// registry.lookup()/packageOf(); inlineAssetCount powers the saveDocToDisk
// safety net that refuses a write which would reduce them.
//
// This file covers the pure exported helper (inlineAssetCount) directly and
// documents the round-trip invariant. The full live round-trip (real editor
// world → saveDocToDisk → disk pack has 7 materials → fresh reload resolves all
// 7) is proven by the playwright verify-serialize / verify-render-after-save
// probes; a headless bun test cannot host the WebGPU editor world.

import { describe, expect, it } from 'bun:test';
import { inlineAssetCount, wouldDropInlineAssets, mergeLoadedInlineOrphans } from '../store/store';

describe('inlineAssetCount — safety-net counter for save round-trip', () => {
  it('counts non-scene asset entries (inline material bodies)', () => {
    const pack = {
      schemaVersion: '1.0.0',
      kind: 'internal-text-package',
      assets: [
        { guid: 's', kind: 'scene', payload: { kind: 'scene', entities: [] }, refs: ['m1', 'm2'] },
        { guid: 'm1', kind: 'material', payload: { kind: 'material' }, refs: [] },
        { guid: 'm2', kind: 'material', payload: { kind: 'material' }, refs: [] },
      ],
    };
    expect(inlineAssetCount(pack)).toBe(2);
  });

  it('returns 0 for a scene-only pack (the truncated/buggy shape)', () => {
    const truncated = {
      schemaVersion: '1.0.0',
      kind: 'internal-text-package',
      assets: [{ guid: 's', kind: 'scene', payload: { kind: 'scene', entities: [] }, refs: ['m1'] }],
    };
    expect(inlineAssetCount(truncated)).toBe(0);
  });

  it('detects the drop: a scene-only pack loses inline assets vs a full one', () => {
    const full = {
      assets: [
        { kind: 'scene' },
        { kind: 'material' },
        { kind: 'material' },
        { kind: 'texture' },
      ],
    };
    const truncated = { assets: [{ kind: 'scene' }] };
    // The saveDocToDisk safety net aborts when newCount < oldCount.
    expect(inlineAssetCount(truncated)).toBeLessThan(inlineAssetCount(full));
    expect(inlineAssetCount(full)).toBe(3);
  });

  it('is defensive against malformed input (no assets array)', () => {
    expect(inlineAssetCount(null)).toBe(0);
    expect(inlineAssetCount({})).toBe(0);
    expect(inlineAssetCount({ assets: 'nope' })).toBe(0);
    expect(inlineAssetCount(undefined)).toBe(0);
  });
});

// The load-FLOOR guard (wouldDropInlineAssets) replaces the old count-vs-current-
// disk check. Anchoring to what the scene was LOADED with — not the current on-disk
// file — is what defeats the self-perpetuating strip loop that turned hello5 grey:
// once a stripping write hit disk, the old guard compared 0 (new) >= 0 (disk) and
// passed forever. The floor is the on-disk material count captured at load; both
// the awaited save and the sync unload beacon refuse any pack below it.
describe('wouldDropInlineAssets — load-floor material-strip guard', () => {
  const full = { assets: [{ kind: 'scene' }, { kind: 'material' }, { kind: 'material' }] }; // 2 inline
  const stripped = { assets: [{ kind: 'scene' }] }; // 0 inline

  it('refuses a save that drops below the load floor (the strip)', () => {
    expect(wouldDropInlineAssets(2, stripped)).toBe(true);
  });

  it('allows a save that preserves the floor', () => {
    expect(wouldDropInlineAssets(2, full)).toBe(false);
  });

  it('allows a save that ADDS inline assets above the floor', () => {
    const more = { assets: [{ kind: 'scene' }, { kind: 'material' }, { kind: 'material' }, { kind: 'material' }] };
    expect(wouldDropInlineAssets(2, more)).toBe(false);
  });

  it('DEFEATS the fixed point: floor=2 still refuses a 0-material re-strip even after disk is already 0', () => {
    // The old bug: prior save stripped disk to 0, so 0 >= 0 (new vs disk) passed
    // and re-stripped forever. The floor (2, from load) refuses it regardless of
    // what is currently on disk.
    expect(wouldDropInlineAssets(2, stripped)).toBe(true);
  });

  it('null floor (no scene loaded yet) never blocks — first-time save proceeds', () => {
    expect(wouldDropInlineAssets(null, stripped)).toBe(false);
    expect(wouldDropInlineAssets(null, full)).toBe(false);
  });
});

describe('mergeLoadedInlineOrphans — preserve unused inline bodies across save', () => {
  it('re-appends a load-snapshot orphan missing from serialized refs walk', () => {
    const pack = {
      schemaVersion: '1.0.0',
      kind: 'internal-text-package',
      assets: [
        { guid: 's', kind: 'scene', payload: {}, refs: ['m1'] },
        { guid: 'm1', kind: 'material', payload: { kind: 'material', name: 'used' }, refs: [] },
      ],
    };
    const orphans = [
      { guid: 'm1', kind: 'material', payload: { kind: 'material', name: 'used' }, refs: [] },
      { guid: 'd480b87c-orphan', kind: 'material', payload: { kind: 'material', name: 'orphan' }, refs: [] },
    ];
    const merged = mergeLoadedInlineOrphans(pack as Record<string, unknown>, orphans);
    expect(merged).toBe(1);
    expect(inlineAssetCount(pack)).toBe(2);
    const orphan = pack.assets.find((a) => a.guid === 'd480b87c-orphan') as { payload: { name: string } };
    expect(orphan?.payload?.name).toBe('orphan');
  });

  it('is a no-op when snapshot is null/empty or already complete', () => {
    const pack = {
      assets: [
        { guid: 's', kind: 'scene' },
        { guid: 'm1', kind: 'material', payload: {}, refs: [] },
      ],
    };
    expect(mergeLoadedInlineOrphans(pack as Record<string, unknown>, null)).toBe(0);
    expect(mergeLoadedInlineOrphans(pack as Record<string, unknown>, [])).toBe(0);
    expect(
      mergeLoadedInlineOrphans(pack as Record<string, unknown>, [
        { guid: 'm1', kind: 'material', payload: {}, refs: [] },
      ]),
    ).toBe(0);
    expect(inlineAssetCount(pack)).toBe(1);
  });

  it('with orphan merge, floor guard allows the previously-aborting 11-vs-12 case', () => {
    const serialized = {
      assets: [
        { kind: 'scene' },
        ...Array.from({ length: 11 }, (_, i) => ({ guid: `m${i}`, kind: 'material' })),
      ],
    };
    expect(wouldDropInlineAssets(12, serialized)).toBe(true);
    mergeLoadedInlineOrphans(serialized as Record<string, unknown>, [
      { guid: 'd480-orphan', kind: 'material', payload: { keep: true }, refs: [] },
    ]);
    expect(inlineAssetCount(serialized)).toBe(12);
    expect(wouldDropInlineAssets(12, serialized)).toBe(false);
  });
});
