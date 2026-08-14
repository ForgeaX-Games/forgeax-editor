// asset-preview-material-schema-driven.test.tsx — regression guard for the
// Material properties panel rewrite (schema-driven, "display not
// comprehensive" fix).
//
// The pre-rewrite panel hard-coded baseColor/metallic/roughness plus a
// TEXTURE_FIELD_NAMES whitelist of three slots — every other standard-PBR
// parameter (emissive / clearcoat / specularTint / specularTintTexture …) and
// every custom-shader parameter was invisible. The row model now derives from
// the shader paramSchema SSOT via editor-core; these assertions pin that
// architecture so the hard-coded subset cannot creep back.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';

const source = (file: string): string => readFileSync(resolve(import.meta.dir, '..', file), 'utf8');

describe('AssetPreviewMaterial is schema-driven', () => {
  it('derives its row model from editor-core material-param-schema helpers', () => {
    const panel = source('asset-inspector/AssetPreviewMaterial.tsx');
    expect(panel).toContain('resolveMaterialParamSchema');
    expect(panel).toContain('deriveMaterialParamRows');
    expect(panel).toContain('ensureShaderParamSchemaIndex');
  });

  it('has no hard-coded parameter or texture-slot whitelist', () => {
    const panel = source('asset-inspector/AssetPreviewMaterial.tsx');
    expect(panel).not.toContain('TEXTURE_FIELD_NAMES');
    expect(panel).not.toContain("'baseColorTexture',");
    expect(panel).not.toContain('SURFACE_PARAM_KEYS');
  });

  it('displays parent-chain resolved values, not just the material\'s own', () => {
    const panel = source('asset-inspector/AssetPreviewMaterial.tsx');
    expect(panel).toContain('resolveOverrides');
    expect(panel).toContain('ensureMaterialChainCataloged');
  });

  it('routes in-progress drags through the transient preview channel, commits through the ledger', () => {
    const panel = source('asset-inspector/AssetPreviewMaterial.tsx');
    expect(panel).toContain('setMaterialPreviewParam');
    expect(panel).toContain("kind: 'updateMaterialParams'");
  });

  it('projects Two Sided / Blend from the authored pass renderState', () => {
    const panel = source('asset-inspector/AssetPreviewMaterial.tsx');
    expect(panel).toContain('materialRenderStateFacts');
    expect(panel).toContain('mat-render-state');
  });

  it('the preview viewport owns overlay teardown on the post-commit assetsChanged', () => {
    // The panel deliberately does NOT clear staging on dispatch: the viewport
    // drops the overlay when the re-resolved (post-write) values land, so the
    // preview never flickers back to the pre-commit value in between.
    const viewport = readFileSync(
      resolve(import.meta.dir, '../../../edit-runtime/src/viewport/MaterialPreviewViewport.tsx'),
      'utf8',
    );
    expect(viewport).toContain('clearMaterialPreviewParams');
    expect(viewport).toContain('getMaterialPreviewParams');
    expect(viewport).toContain('assetsChanged');
  });
});

describe('Material page preview panel', () => {
  it('registers the mat-preview panel component in the editor panel map', () => {
    const manifest = source('manifest.ts');
    expect(manifest).toContain("'mat-preview': MaterialPreviewPanel");
  });

  it('reuses the host-injected preview viewport slot (panels must not import edit-runtime)', () => {
    const editors = source('AssetEditors.tsx');
    expect(editors).toContain('MaterialPreviewPanel');
    expect(editors).not.toContain('editor-edit-runtime');
  });
});
