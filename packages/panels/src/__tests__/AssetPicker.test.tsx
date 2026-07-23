// AssetPicker — click-to-browse modal for Inspector asset fields.
//
// Guarantee under test: the picker only offers catalogued assets whose kind maps
// (assetKindToType) to the field's expected asset type — so it can never present a
// row the field would reject. Also covers the "None (unbind)" row and empty state.
//
// We do NOT mock @forgeax/editor-core wholesale (that shadows every other named
// export and breaks sibling test files). Instead we keep the real module and only
// override the two gateway read methods on the singleton, restoring them after.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { gateway } from '@forgeax/editor-core';

import { AssetPicker } from '../AssetPicker';

const fakeCatalog = [
  { guid: 'g-cube', kind: 'mesh', name: 'Cube', relativeUrl: 'cube.mesh' },
  { guid: 'g-sphere', kind: 'mesh', name: 'Sphere', relativeUrl: 'sphere.mesh' },
  { guid: 'g-red', kind: 'material', name: 'RedMat', relativeUrl: 'red.mat' },
];

const gw = gateway as unknown as { assetCatalog: unknown; describeAssetByGuid: unknown };
const orig = { assetCatalog: gw.assetCatalog, describeAssetByGuid: gw.describeAssetByGuid };

beforeAll(() => {
  gw.assetCatalog = () => fakeCatalog;
  gw.describeAssetByGuid = () => ({ ok: false });
});

afterAll(() => {
  gw.assetCatalog = orig.assetCatalog;
  gw.describeAssetByGuid = orig.describeAssetByGuid;
});

describe('AssetPicker', () => {
  it('MeshAsset field → only mesh rows, materials filtered out', () => {
    const html = renderToStaticMarkup(
      <AssetPicker assetType="MeshAsset" onPick={() => {}} onClose={() => {}} />,
    );
    expect(html).toContain('asset-picker-row-g-cube');
    expect(html).toContain('asset-picker-row-g-sphere');
    expect(html).not.toContain('asset-picker-row-g-red');
    expect(html).toContain('Cube');
  });

  it('MaterialAsset field → only material rows', () => {
    const html = renderToStaticMarkup(
      <AssetPicker assetType="MaterialAsset" onPick={() => {}} onClose={() => {}} />,
    );
    expect(html).toContain('asset-picker-row-g-red');
    expect(html).not.toContain('asset-picker-row-g-cube');
  });

  it('renders the None (unbind) row when onClear is provided', () => {
    const html = renderToStaticMarkup(
      <AssetPicker assetType="MeshAsset" onPick={() => {}} onClear={() => {}} onClose={() => {}} />,
    );
    expect(html).toContain('asset-picker-none');
    expect(html).toContain('None (unbind)');
  });

  it('empty state when no catalogued asset matches the type', () => {
    const html = renderToStaticMarkup(
      <AssetPicker assetType="AudioClipAsset" onPick={() => {}} onClose={() => {}} />,
    );
    expect(html).toContain('asset-picker-empty');
    expect(html).toContain('No AudioClipAsset in project');
  });

  it('AudioClipAsset field → only audio rows', () => {
    gw.assetCatalog = () => [
      ...fakeCatalog,
      { guid: 'g-sfx', kind: 'audio', name: 'test_mp3', relativeUrl: 'assets/test_mp3.mp3' },
    ];
    const html = renderToStaticMarkup(
      <AssetPicker assetType="AudioClipAsset" onPick={() => {}} onClose={() => {}} />,
    );
    expect(html).toContain('asset-picker-row-g-sfx');
    expect(html).toContain('test_mp3');
    expect(html).not.toContain('asset-picker-row-g-cube');
    gw.assetCatalog = () => fakeCatalog;
  });
});
