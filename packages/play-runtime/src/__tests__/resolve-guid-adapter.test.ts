/// <reference types="bun" />

import { describe, it, expect } from 'bun:test';
import type { SceneAsset, AssetError } from '@forgeax/engine-types';
import type { ImageError } from '@forgeax/engine-types';
import type { RhiError } from '@forgeax/engine-rhi';

// RED phase: createResolveGuidAdapter will be implemented in ../resolve-guid-adapter.ts (w4).
// The import below will fail to compile until w4 adds the export.
import { createResolveGuidAdapter } from '../resolve-guid-adapter';

// --------------- helpers ---------------

const TEST_GUID = 'deadbeef-dead-beef-dead-beefdeadbeef';

function scenePayload(): SceneAsset {
  return { kind: 'scene', entities: [] };
}

function mockAssetError(): AssetError {
  return {
    name: 'AssetError',
    message: '[AssetError asset-not-found] expected: guid in registry; hint: check forge.json',
    code: 'asset-not-found',
    expected: 'guid in registry',
    hint: 'check forge.json',
  } as AssetError;
}

function mockImageError(): ImageError {
  return {
    name: 'ImageError',
    message: '[ImageError image-decode-failed] expected: valid PNG/JPG; hint: check file integrity',
    code: 'image-decode-failed',
    expected: 'valid PNG/JPG',
    hint: 'check file integrity',
    detail: { code: 'image-decode-failed' as const, reason: 'bad header' },
  } as ImageError;
}

function mockRhiError(): RhiError {
  return {
    name: 'RhiError',
    message: '[RhiError device-lost] expected: device alive; hint: check GPU',
    code: 'device-lost',
    expected: 'device alive',
    hint: 'check GPU',
  } as RhiError;
}

// --------------- tests ---------------

describe('createResolveGuidAdapter', () => {
  it('success: extracts .kind from SceneAsset payload and backfills guid', async () => {
    const payload = scenePayload();
    const loadByGuid = async (_guid: string) => ({ ok: true as const, value: payload });
    const adapter = createResolveGuidAdapter(loadByGuid);
    const result = await adapter(TEST_GUID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe('scene');
      expect(result.value.guid).toBe(TEST_GUID);
    }
  });

  it('AssetError: pass-through error object unchanged (preserves code/expected/hint)', async () => {
    const original = mockAssetError();
    const loadByGuid = async (_guid: string) => ({ ok: false as const, error: original });
    const adapter = createResolveGuidAdapter(loadByGuid);
    const result = await adapter('bad-guid');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Same object reference — adapter does NOT wrap/rewrite/mutate the error.
      expect(result.error).toBe(original);
      // Properties accessible for AI-user structured consumption (charter P3).
      expect((result.error as AssetError).code).toBe('asset-not-found');
      expect((result.error as AssetError).expected).toBe('guid in registry');
      expect((result.error as AssetError).hint).toBe('check forge.json');
    }
  });

  it('ImageError: pass-through error object unchanged (preserves code/expected/hint/detail)', async () => {
    const original = mockImageError();
    const loadByGuid = async (_guid: string) => ({ ok: false as const, error: original });
    const adapter = createResolveGuidAdapter(loadByGuid);
    const result = await adapter('bad-guid');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(original);
      expect((result.error as ImageError).code).toBe('image-decode-failed');
      const detail = (result.error as ImageError).detail;
      expect(detail.code).toBe('image-decode-failed');
    }
  });

  it('RhiError: pass-through error object unchanged (preserves code/expected/hint)', async () => {
    const original = mockRhiError();
    const loadByGuid = async (_guid: string) => ({ ok: false as const, error: original });
    const adapter = createResolveGuidAdapter(loadByGuid);
    const result = await adapter('bad-guid');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(original);
      expect((result.error as RhiError).code).toBe('device-lost');
    }
  });
});