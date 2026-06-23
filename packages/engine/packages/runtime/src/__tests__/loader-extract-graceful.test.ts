// loader-extract-graceful.test.ts -- M4 / w24 integration test for the
// paramSchema-driven loader/extract handoff.
//
// feat-20260613-material-paramschema-driven-binding M4 / w24.
//
// Decision anchors (plan-strategy section 2 + section 5.3):
//   - D-5  loader does not pre-filter texture fields by hardcoded name; the
//          paramSchema-derived textureFieldNames is the SSOT. Cross-worktree
//          shader-late-register falls back to "try every int paramValue"
//          gracefully; the extract layer's paramSchema validation catches
//          misclassifications and routes through MISSING_TEXTURE_HANDLE.
//   - R-4  shader-late-register risk: material loaded before its shader is
//          registered. The graceful fallback keeps the load path live.
//
// Four scenarios (plan-strategy section 5.3 acceptance):
//   (1) shader registered + texture-typed paramValue + valid texture handle
//       -> loader resolves, extract keeps the handle (passthrough).
//   (2) shader registered + texture-typed paramValue + refs unresolved
//       -> loader drops the field, extract reads undefined, record stage
//          falls back to MISSING_TEXTURE_HANDLE (default white).
//   (3) shader NOT registered yet (cross-worktree R-4) + int paramValue
//       -> loader's graceful fallback resolves every int in [0, refs.length)
//          to a handle.
//   (4) shader registered + scalar-typed paramValue (metallic = 0) whose
//       value happens to land in [0, refs.length) -> loader's
//       paramSchema-aware path skips it (only declared texture fields are
//       resolved); the field stays as the original int.

import type { LoadContext, ParamSchemaEntry } from '@forgeax/engine-types';
import { derive } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { materialLoader } from '../asset-registry';

function makeCtx(opts: {
  resolveRefSync?: (guid: string) => number | undefined;
  shaderTextureFieldNames?: (shaderId: string) => ReadonlySet<string> | undefined;
}): LoadContext {
  const ctx: LoadContext = {
    fetchBinary: async () => ({ ok: false as const, error: new Error('no binary') }),
    resolveRef: async () => ({ ok: false as const, error: new Error('no ref') }),
    device: undefined,
    reportParseError: () => {},
  };
  if (opts.resolveRefSync) ctx.resolveRefSync = opts.resolveRefSync;
  if (opts.shaderTextureFieldNames) {
    ctx.getMaterialShaderTextureFieldNames = opts.shaderTextureFieldNames;
  }
  return ctx;
}

const standardPbrSchema: readonly ParamSchemaEntry[] = [
  { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
  { name: 'metallic', type: 'f32', default: 0 },
  { name: 'roughness', type: 'f32', default: 0.5 },
  { name: 'baseColorTexture', type: 'texture2d' },
  { name: 'normalTexture', type: 'texture2d' },
];

describe('loader-extract graceful handoff (M4 w24)', () => {
  it('(1) shader registered + valid texture refs[] index resolves to handle', () => {
    const textureFields = derive(standardPbrSchema).textureFieldNames;
    const ctx = makeCtx({
      resolveRefSync: (guid) => (guid === 'tex-bc-guid' ? 100 : undefined),
      shaderTextureFieldNames: (id) =>
        id === 'forgeax::default-standard-pbr' ? textureFields : undefined,
    });
    const out = materialLoader.load(
      {
        passes: [{ shader: 'forgeax::default-standard-pbr' }],
        paramValues: { baseColorTexture: 0, metallic: 0.5 },
      },
      ['tex-bc-guid'],
      ctx,
    );
    expect(out).toMatchObject({ kind: 'material' });
    const pv = (out as { paramValues: Record<string, unknown> }).paramValues;
    // Texture field resolved to handle 100.
    expect(pv.baseColorTexture).toBe(100);
    // Scalar field unchanged.
    expect(pv.metallic).toBe(0.5);
  });

  it('(2) shader registered + texture refs[] entry not registered -> field dropped', () => {
    const textureFields = derive(standardPbrSchema).textureFieldNames;
    const ctx = makeCtx({
      resolveRefSync: () => undefined, // texture sub-asset not registered
      shaderTextureFieldNames: (id) =>
        id === 'forgeax::default-standard-pbr' ? textureFields : undefined,
    });
    const out = materialLoader.load(
      {
        passes: [{ shader: 'forgeax::default-standard-pbr' }],
        paramValues: { baseColorTexture: 0 },
      },
      ['tex-bc-guid'],
      ctx,
    );
    expect(out).toMatchObject({ kind: 'material' });
    const pv = (out as { paramValues: Record<string, unknown> }).paramValues;
    // Loader drops the field; record stage falls back to MISSING_TEXTURE_HANDLE.
    expect('baseColorTexture' in pv).toBe(false);
  });

  it('(3) shader NOT registered (R-4 cross-worktree) -> graceful "try every int" fallback', () => {
    // No paramSchema lookup available -> getMaterialShaderTextureFieldNames
    // returns undefined for every shader id.
    const ctx = makeCtx({
      resolveRefSync: (guid) => (guid === 'tex-guid' ? 200 : undefined),
      shaderTextureFieldNames: () => undefined,
    });
    const out = materialLoader.load(
      {
        passes: [{ shader: 'forgeax::user-defined' }],
        paramValues: { customTexture: 0 },
      },
      ['tex-guid'],
      ctx,
    );
    expect(out).toMatchObject({ kind: 'material' });
    const pv = (out as { paramValues: Record<string, unknown> }).paramValues;
    // Graceful fallback resolves any int in [0, refs.length).
    expect(pv.customTexture).toBe(200);
  });

  it('(4) shader registered + scalar paramValue with refs[] index in range -> NOT misclassified', () => {
    const textureFields = derive(standardPbrSchema).textureFieldNames;
    const ctx = makeCtx({
      resolveRefSync: () => 999, // would resolve if attempted
      shaderTextureFieldNames: (id) =>
        id === 'forgeax::default-standard-pbr' ? textureFields : undefined,
    });
    const out = materialLoader.load(
      {
        passes: [{ shader: 'forgeax::default-standard-pbr' }],
        // metallic = 0 is an int in [0, refs.length=1) — would misclassify
        // under a naive "try every int" loader. paramSchema-aware path
        // declares metallic as 'f32', so it skips resolution.
        paramValues: { baseColorTexture: 0, metallic: 0 },
      },
      ['tex-bc-guid'],
      ctx,
    );
    expect(out).toMatchObject({ kind: 'material' });
    const pv = (out as { paramValues: Record<string, unknown> }).paramValues;
    // Texture field still resolves.
    expect(pv.baseColorTexture).toBe(999);
    // Scalar field unchanged: metallic stays 0, NOT 999.
    expect(pv.metallic).toBe(0);
  });
});
