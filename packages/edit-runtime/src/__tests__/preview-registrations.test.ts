// Regression: hosts that forgot to register the preview viewports render
// "… preview viewport is not registered by the host" placeholders (Studio
// shipped that gap for material/mesh/vfx previews). The facade subpath
// @forgeax/editor/previews must fill ALL THREE slots in one call.
import { describe, expect, it } from 'bun:test';
import {
  getMaterialInstancePreview,
  getMeshPreview,
  getVfxPreview,
} from '@forgeax/editor-panels';
import { registerEditorPreviewViewports } from '../viewport/preview-registrations';
import { MaterialPreviewViewport } from '../viewport/MaterialPreviewViewport';
import { MeshPreviewViewport } from '../viewport/MeshPreviewViewport';
import { VfxPreviewViewport } from '../viewport/VfxPreviewViewport';

describe('registerEditorPreviewViewports (host preview-slot wiring)', () => {
  it('registers the material/mesh/vfx preview viewports into the panel slots', () => {
    registerEditorPreviewViewports();
    expect(getMaterialInstancePreview()).toBe(MaterialPreviewViewport);
    expect(getMeshPreview()).toBe(MeshPreviewViewport);
    expect(getVfxPreview()).toBe(VfxPreviewViewport);
  });
});
