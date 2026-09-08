// Regression: hosts that forgot to register the preview viewports render
// placeholders. The facade subpath @forgeax/editor/previews must fill ALL
// preview slots in one call.
import { describe, expect, it } from 'bun:test';
import {
  getMaterialInstancePreview,
  getMeshPreview,
  getTexturePreview,
  getVfxPreview,
} from '@forgeax/editor-panels';
import { registerEditorPreviewViewports } from '../viewport/preview-registrations';
import { MaterialPreviewViewport } from '../viewport/MaterialPreviewViewport';
import { MeshPreviewViewport } from '../viewport/MeshPreviewViewport';
import { TexturePreviewViewport } from '../viewport/TexturePreviewViewport';
import { VfxPreviewViewport } from '../viewport/VfxPreviewViewport';

describe('registerEditorPreviewViewports (host preview-slot wiring)', () => {
  it('registers the material/mesh/texture/vfx preview viewports into the panel slots', () => {
    registerEditorPreviewViewports();
    expect(getMaterialInstancePreview()).toBe(MaterialPreviewViewport);
    expect(getMeshPreview()).toBe(MeshPreviewViewport);
    expect(getTexturePreview()).toBe(TexturePreviewViewport);
    expect(getVfxPreview()).toBe(VfxPreviewViewport);
  });
});
