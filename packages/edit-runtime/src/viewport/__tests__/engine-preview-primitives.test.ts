import { describe, expect, it } from 'bun:test';
import {
  createMaterialPreviewPrimitive,
  createMeshPreviewPrimitive,
  createTexturePreviewPrimitive,
  createVfxPreviewPrimitive,
} from '@forgeax/engine-preview';

const snapshot = { revision: 4, digest: 'sha256:project-4' } as const;

describe('Engine-owned preview primitive consumers', () => {
  it('keeps all four domain identities explicit and subject-bound', () => {
    const material = createMaterialPreviewPrimitive({
      subjectGuid: 'mat-1',
      snapshot,
      binding: { guid: 'mat-1', programDigest: 'sha256:program', bindings: ['baseColor'] },
    });
    const mesh = createMeshPreviewPrimitive({
      subjectGuid: 'mesh-1',
      snapshot,
      binding: {
        guid: 'mesh-1',
        vertexDigest: 'sha256:vertices',
        indexDigest: 'sha256:indices',
        submeshes: [{ id: 'body', vertexCount: 3, indexCount: 3 }],
        aabb: { min: [-1, -1, -1], max: [1, 1, 1] },
      },
    });
    const vfx = createVfxPreviewPrimitive({
      subjectGuid: 'vfx-1',
      snapshot,
      binding: { guid: 'vfx-1', effectDigest: 'sha256:effect' },
      simulation: { seed: 7, deltaSeconds: 1 / 60, frames: 8 },
    });
    const texture = createTexturePreviewPrimitive({
      subjectGuid: 'tex-1',
      snapshot,
      binding: {
        guid: 'tex-1',
        width: 4,
        height: 2,
        format: 'rgba8unorm',
        colorSpace: 'srgb',
        alpha: true,
        mipLevels: 2,
        channels: 4,
      },
    });

    expect([material, mesh, vfx, texture].map((value) => value.operationId)).toEqual([
      'material.preview',
      'mesh.preview',
      'vfx.preview',
      'texture.preview',
    ]);
    expect([material, mesh, vfx, texture].map((value) => value.source)).toEqual([
      'engine',
      'engine',
      'engine',
      'engine',
    ]);
    expect(material.subject.guid).toBe(material.binding.guid);
    expect(mesh.subject.guid).toBe(mesh.binding.guid);
    expect(vfx.subject.guid).toBe(vfx.binding.guid);
    expect(texture.subject.guid).toBe(texture.binding.guid);
  });

  it('rejects disconnected bindings and generic or fallback preview identities', () => {
    expect(() => createMaterialPreviewPrimitive({
      subjectGuid: 'mat-1',
      snapshot,
      binding: { guid: 'other', programDigest: 'sha256:program', bindings: ['baseColor'] },
    })).toThrow(/subject|binding/i);
    expect(() => createTexturePreviewPrimitive({
      subjectGuid: 'tex-1',
      snapshot,
      binding: {
        guid: 'tex-1',
        width: 0,
        height: 2,
        format: 'rgba8unorm',
        colorSpace: 'srgb',
        alpha: true,
        mipLevels: 1,
        channels: 4,
      },
    })).toThrow(/texture|dimension/i);
    expect(['material.preview', 'mesh.preview', 'vfx.preview', 'texture.preview']).not.toContain(
      'asset.preview',
    );
  });
});
