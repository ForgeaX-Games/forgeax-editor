// AssetPicker — UE-style anchored asset browser for Inspector asset fields.
//
// Guarantee under test: the picker only offers catalogued assets whose kind maps
// (assetKindToType) to the field's expected asset type — so it can never present a
// row the field would reject. Also covers the "None (unbind)" row and empty state.
//
// We do NOT mock @forgeax/editor-core wholesale (that shadows every other named
// export and breaks sibling test files). Instead we keep the real module and only
// override the two gateway read methods on the singleton, restoring them after.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { bindViewportRuntimeClient, gateway } from '@forgeax/editor-core';

import { AssetPicker } from '../AssetPicker';

const fakeCatalog = [
  { guid: 'g-cube', kind: 'mesh', name: 'Cube', packageUrl: 'cube.mesh', authoring: { placement: { operation: 'spawnEntity' }, binding: { operation: 'bindAssetRef', target: { component: 'MeshRenderer', field: 'mesh', assetType: 'MeshAsset', cardinality: 'single' }, requiredSlots: 1 } } },
  { guid: 'g-sphere', kind: 'mesh', name: 'Sphere', packageUrl: 'sphere.mesh', authoring: { placement: { operation: 'spawnEntity' }, binding: { operation: 'bindAssetRef', target: { component: 'MeshRenderer', field: 'mesh', assetType: 'MeshAsset', cardinality: 'single' }, requiredSlots: 1 } } },
  { guid: 'g-red', kind: 'material', name: 'RedMat', packageUrl: 'red.mat', authoring: { placement: { operation: 'spawnEntity' }, binding: { operation: 'bindAssetRef', target: { component: 'StandardMaterial', field: 'material', assetType: 'MaterialAsset', cardinality: 'single' }, requiredSlots: 1 } } },
  { guid: 'g-run', kind: 'animation-clip', name: 'Run', packageUrl: 'run.anim', authoring: { placement: { operation: 'spawnEntity' }, binding: { operation: 'bindAssetRef', target: { component: 'AnimationPlayer', field: 'clips', assetType: 'AnimationClip', cardinality: 'many' }, requiredSlots: 1 } } },
  { guid: 'g-walk', kind: 'animation-clip', name: 'Walk', packageUrl: 'fox.anim', authoring: { placement: { operation: 'spawnEntity' }, binding: { operation: 'bindAssetRef', target: { component: 'AnimationPlayer', field: 'clips', assetType: 'AnimationClip', cardinality: 'many' }, requiredSlots: 1 } } },
];

const gw = gateway as unknown as { assetCatalog: unknown; describeAssetByGuid: unknown };
const origDescribeAssetByGuid = gw.describeAssetByGuid;
const compatibleCatalog = (rows: readonly Record<string, unknown>[], assetType?: string) => ({
  ok: true as const,
  assets: assetType === undefined ? rows : rows.filter((row) => {
    const binding = (row.authoring as { binding?: { operation: string; target?: { assetType: string } } } | undefined)?.binding;
    return binding?.operation !== 'unavailable' && binding?.target?.assetType === assetType;
  }),
});

const runtime = {
  version: 'viewport-runtime/v1',
  runtimeId: 'asset-picker-test',
  runtimeGeneration: 1,
  carrierId: 'asset-picker-test-frame',
  carrierKind: 'iframe',
} as const;
let catalogRows: readonly Record<string, unknown>[] = fakeCatalog;
let disposeRuntime: (() => void) | undefined;

beforeAll(() => {
  gw.describeAssetByGuid = () => ({ ok: false });
  disposeRuntime = bindViewportRuntimeClient(runtime, {
    request: async (request) => {
      const params = request.params;
      const compatibleWith = params !== null
        && typeof params === 'object'
        && 'compatibleWith' in params
        && typeof params.compatibleWith === 'string'
        ? params.compatibleWith
        : undefined;
      return {
        jsonrpc: '2.0',
        version: 'editor-transport/v1',
        id: request.id,
        correlationId: request.correlationId,
        result: {
          version: 'viewport-runtime/v1',
          runtime,
          revision: 1,
          status: 'ready',
          value: { entries: compatibleCatalog(catalogRows, compatibleWith).assets },
        },
      };
    },
    dispose() {},
  });
});

afterAll(() => {
  disposeRuntime?.();
  gw.describeAssetByGuid = origDescribeAssetByGuid;
});

afterEach(() => {
  catalogRows = fakeCatalog;
});

async function renderPicker(element: ReactElement): Promise<string> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
    await Promise.resolve();
  });
  const picker = document.body.querySelector('[data-testid="asset-picker"]');
  const html = picker?.outerHTML ?? document.body.innerHTML;
  act(() => root.unmount());
  document.body.querySelectorAll('.fx-asset-picker, .fx-asset-picker-backdrop').forEach((node) => node.remove());
  container.remove();
  return html;
}

describe('AssetPicker', () => {
  it('MeshAsset field → only mesh rows, materials filtered out', async () => {
    const html = await renderPicker(
      <AssetPicker assetType="MeshAsset" onPick={() => {}} onClose={() => {}} />,
    );
    expect(html).toContain('asset-picker-row-g-cube');
    expect(html).toContain('asset-picker-row-g-sphere');
    expect(html).not.toContain('asset-picker-row-g-red');
    expect(html).toContain('Cube');
  });

  it('MaterialAsset field → only material rows', async () => {
    const html = await renderPicker(
      <AssetPicker assetType="MaterialAsset" onPick={() => {}} onClose={() => {}} />,
    );
    expect(html).toContain('asset-picker-row-g-red');
    expect(html).not.toContain('asset-picker-row-g-cube');
  });

  it('renders the None (unbind) row when onClear is provided', async () => {
    const html = await renderPicker(
      <AssetPicker assetType="MeshAsset" onPick={() => {}} onClear={() => {}} onClose={() => {}} />,
    );
    expect(html).toContain('asset-picker-none');
    expect(html).toContain('None');
  });

  it('empty state when no catalogued asset matches the type', async () => {
    const html = await renderPicker(
      <AssetPicker assetType="AudioClipAsset" onPick={() => {}} onClose={() => {}} />,
    );
    expect(html).toContain('asset-picker-empty');
    expect(html).toContain('No AudioClipAsset in project');
  });

  // Regression (animation-preview M1): the catalogued kind the gltf/inline-pack
  // cooks emit for clips is 'animation-clip' (AnimationClipAsset.kind) — without
  // the mapping an AnimationPlayer clips slot's picker listed NOTHING.
  it('AnimationClip field → catalogued animation-clip rows', async () => {
    const html = await renderPicker(
      <AssetPicker assetType="AnimationClip" onPick={() => {}} onClose={() => {}} />,
    );
    expect(html).toContain('asset-picker-row-g-run');
    expect(html).toContain('Run');
    expect(html).not.toContain('asset-picker-row-g-cube');
    expect(html).not.toContain('asset-picker-row-g-red');
  });

  it('AudioClipAsset field → only audio rows', async () => {
    catalogRows = [
      ...fakeCatalog,
      { guid: 'g-sfx', kind: 'audio', name: 'test_mp3', packageUrl: 'assets/test_mp3.mp3', authoring: { placement: { operation: 'spawnEntity' }, binding: { operation: 'bindAssetRef', target: { component: 'AudioSource', field: 'clip', assetType: 'AudioClipAsset', cardinality: 'single' }, requiredSlots: 1 } } },
    ];
    const html = await renderPicker(
      <AssetPicker assetType="AudioClipAsset" onPick={() => {}} onClose={() => {}} />,
    );
    expect(html).toContain('asset-picker-row-g-sfx');
    expect(html).toContain('test_mp3');
    expect(html).not.toContain('asset-picker-row-g-cube');
  });

  it('ParticleEffectAsset field → producer capability selects particle rows', async () => {
    catalogRows = [
      {
        guid: 'g-particle', kind: 'particle-effect', name: 'Burst', packageUrl: 'burst.pack',
        authoring: {
          placement: { operation: 'spawnEntity' },
          binding: {
            operation: 'bindAssetRef',
            target: { component: 'ParticleEffectPlayer', field: 'effect', assetType: 'ParticleEffectAsset', cardinality: 'single' },
            requiredSlots: 1,
          },
        },
      },
      ...fakeCatalog,
    ];
    const html = await renderPicker(
      <AssetPicker assetType="ParticleEffectAsset" onPick={() => {}} onClose={() => {}} />,
    );
    expect(html).toContain('asset-picker-row-g-particle');
    expect(html).not.toContain('asset-picker-row-g-cube');
  });

  it('AnimationClip field → imported animation-clip rows', async () => {
    const html = await renderPicker(
      <AssetPicker assetType="AnimationClip" onPick={() => {}} onClose={() => {}} />,
    );
    expect(html).toContain('asset-picker-row-g-walk');
    expect(html).toContain('Walk');
    expect(html).not.toContain('asset-picker-row-g-cube');
  });
});
