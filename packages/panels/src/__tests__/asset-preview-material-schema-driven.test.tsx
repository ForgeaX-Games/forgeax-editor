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
    expect(panel).toContain('parameterContract');
    expect(panel).not.toContain('ensureShaderParamSchemaIndex');
    expect(panel).not.toContain('parseShaderParamSchemaIndex');
  });

  it('reads the production Engine MaterialReady contract before schema resolution', () => {
    const panel = source('asset-inspector/AssetPreviewMaterial.tsx');
    expect(panel).toContain('getMaterialReadiness(asset.guid)');
    expect(panel).toContain("materialReadiness?.status === 'Ready'");
    expect(panel).toContain('materialReadiness.parameterContract');
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
    // In-progress drags still preview live through the transient channel from
    // within the panel body...
    expect(panel).toContain('setMaterialPreviewParam');
    // ...but the ledger commit was lifted out of the panel body: Save is now a
    // header panelAction (asset-editors-contributions saveActiveMaterial), which
    // delegates to the registered Material PageController and host ToolClient.
    const contributions = source('asset-editors-contributions.tsx');
    expect(contributions).toContain("host.commands.execute('editor.save')");
    expect(contributions).toContain('editor.save');
  });

  it('projects Two Sided / Blend from the authored pass renderState', () => {
    const panel = source('asset-inspector/AssetPreviewMaterial.tsx');
    expect(panel).toContain('materialRenderStateFacts');
    expect(panel).toContain('mat-render-state');
  });

  it('the preview viewport keeps staging buffer values when catalog rebuild lags', () => {
    const viewport = readFileSync(
      resolve(import.meta.dir, '../../../edit-runtime/src/viewport/MaterialPreviewViewport.tsx'),
      'utf8',
    );
    expect(viewport).toContain('resolveMaterialPreviewDisplayValues');
    expect(viewport).toContain('subscribeMaterialStaging');
    expect(viewport).toContain('isMaterialStagingDirty');
    expect(viewport).toContain('assetsChanged');
    const staging = readFileSync(
      resolve(import.meta.dir, '../../../core/src/assets/material-preview-staging.ts'),
      'utf8',
    );
    expect(staging).toContain('staging.staging.values');
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
