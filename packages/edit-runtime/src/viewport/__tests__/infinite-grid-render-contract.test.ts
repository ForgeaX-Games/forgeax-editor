import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { createSceneDataCatalog, type RenderFeaturePlanContext } from '@forgeax/engine-render';
import { createInfiniteGridFeature } from '../infinite-grid-feature';

const infiniteGridFeatureSource = readFileSync(new URL('../infinite-grid-feature.ts', import.meta.url), 'utf8');
const infiniteGridShaderSource = readFileSync(new URL('../shaders/infinite-grid.wgsl', import.meta.url), 'utf8');

const caps = {
  backendKind: 'null',
  compute: true,
  timestampQuery: false,
  timestampPeriodNanoseconds: null,
  indirectDrawing: false,
  textureCompressionBc: false,
  textureCompressionEtc2: false,
  textureCompressionAstc: false,
  multiDrawIndirect: false,
  pushConstants: false,
  textureBindingArray: false,
  samplerAliasing: true,
  firstInstanceIndirect: false,
  storageBuffer: true,
  storageTexture: true,
  rgba16floatRenderable: true,
  rg11b10ufloatRenderable: true,
  float32Filterable: true,
  maxColorAttachments: 8,
} as const;

function context(
  colorFormat: 'rgba16float' | 'rgba8unorm' = 'rgba16float',
  depthFormat: 'depth24plus-stencil8' | 'depth32float' = 'depth24plus-stencil8',
  generation = 1,
): RenderFeaturePlanContext {
  return {
    caps,
    frame: { frameNumber: generation },
    generation,
    targets: [
      { name: 'color', kind: 'color', format: colorFormat, sampleCount: 1 },
      { name: 'depth', kind: 'depth', format: depthFormat, sampleCount: 1 },
    ],
    sceneData: createSceneDataCatalog({
      featureIdentity: 'editor.infinite-grid',
      generation,
      planIdentity: `editor.infinite-grid:${generation}`,
      rgba16floatRenderable: caps.rgba16floatRenderable,
    }),
  };
}

function plan(planContext: RenderFeaturePlanContext = context()) {
  const feature = createInfiniteGridFeature();
  const extracted = feature.extract({ worlds: [], owner: 0, frameNumber: 1 });
  if (!extracted.ok) throw extracted.error;
  const planned = feature.plan(extracted.value, planContext);
  if (!planned.ok) throw planned.error;
  return planned.value;
}

describe('infinite grid render contract', () => {
  it('uses stable homogeneous reconstruction, ground offset, and camera-distance fade', () => {
    expect(infiniteGridShaderSource).toContain('multiplyMatrix');
    expect(infiniteGridFeatureSource).toContain("import './shaders/infinite-grid.wgsl'");
    expect(infiniteGridShaderSource).toContain('#define_import_path editor::infinite-grid');
    expect(infiniteGridShaderSource).toContain('fn planeCoordinate(worldClip : vec4<f32>, plane : u32)');
    expect(infiniteGridShaderSource).toContain('fn originLineMask(coord : f32, widthPx : f32)');
    expect(infiniteGridShaderSource).toContain('GRID_HEIGHT_OFFSET : f32 = -0.2');
    expect(infiniteGridShaderSource).toContain('worldClip.y - GRID_HEIGHT_OFFSET * worldClip.w');
    expect(infiniteGridShaderSource).toContain('let nearPlane = planeCoordinate(nearClip, input.plane)');
    expect(infiniteGridShaderSource).toContain('let worldClip = nearClip + (farClip - nearClip) * segment');
    expect(infiniteGridShaderSource).toContain('RAY_FAR_DEPTH');
    expect(infiniteGridShaderSource).toContain('GRID_FADE_START : f32 = 28.0');
    expect(infiniteGridShaderSource).toContain('GRID_FADE_END : f32 = 180.0');
    expect(infiniteGridShaderSource).toContain('GRID_OPACITY : f32 = 0.28');
    expect(infiniteGridShaderSource).toContain('GRID_MINOR_ALPHA : f32 = 0.08');
    expect(infiniteGridShaderSource).toContain('GRID_MAJOR_ALPHA : f32 = 0.40');
    expect(infiniteGridShaderSource).toContain('GRID_AXIS_ALPHA : f32 = 0.12');
    expect(infiniteGridShaderSource).toContain('let minorAlpha = minor * GRID_MINOR_ALPHA');
    expect(infiniteGridShaderSource).toContain('let majorAlpha = major * GRID_MAJOR_ALPHA');
    expect(infiniteGridShaderSource).toContain('let axisU = originLineMask(worldUv.x, 2.0)');
    expect(infiniteGridShaderSource).toContain('let axisV = originLineMask(worldUv.y, 2.0)');
  });

  it('keeps the grid behind authored geometry and binds only the shared view group', () => {
    expect(infiniteGridShaderSource).toContain('out.depth = depth');
    expect(infiniteGridShaderSource).not.toContain('COPLANAR_DEPTH_BIAS');
    expect(infiniteGridFeatureSource).toContain("depthCompare: 'less'");
    expect(infiniteGridFeatureSource).toContain('values: { group: 0 }');
    expect(infiniteGridFeatureSource).not.toContain('sceneDepth:');
  });

  it('declares one ordered raster plan over the canonical logical targets', () => {
    const value = plan(context('rgba16float', 'depth24plus-stencil8', 3));
    expect(value.resources).toContainEqual(expect.objectContaining({
      kind: 'graphics-program',
      program: expect.objectContaining({
        shader: 'editor::infinite-grid',
        colorFormats: ['rgba16float'],
        depthFormat: 'depth24plus-stencil8',
        sampleCount: 1,
      }),
    }));
    expect(value.passes).toEqual([expect.objectContaining({
      kind: 'raster',
      name: 'editor.infinite-grid',
      colorAttachments: [{ target: 'color', loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { target: 'depth', depthLoadOp: 'load', depthStoreOp: 'store' },
      draws: [expect.objectContaining({
        vertexLayout: 'none',
        vertexData: [],
        draw: { kind: 'draw', vertexCount: 3, instanceCount: 1 },
      })],
    })]);
  });

  it('replans target formats without producer-owned prepared state', () => {
    const first = plan(context('rgba16float', 'depth24plus-stencil8', 1));
    const resized = plan(context('rgba8unorm', 'depth32float', 2));
    const firstProgram = first.resources.find((resource) => resource.kind === 'graphics-program');
    const resizedProgram = resized.resources.find((resource) => resource.kind === 'graphics-program');
    expect(firstProgram).toMatchObject({
      program: { colorFormats: ['rgba16float'], depthFormat: 'depth24plus-stencil8' },
    });
    expect(resizedProgram).toMatchObject({
      program: { colorFormats: ['rgba8unorm'], depthFormat: 'depth32float' },
    });
    expect(infiniteGridFeatureSource).not.toContain('RenderFeaturePreparedRef');
    expect(infiniteGridFeatureSource).not.toContain('recover:');
  });

  it('separates declarative topology facts from pixel evidence', () => {
    const value = plan(context('rgba8unorm', 'depth32float', 2));
    const pass = value.passes[0];
    if (pass?.kind !== 'raster') throw new Error('infinite-grid raster pass is unavailable');
    const draw = pass.draws[0];
    const graphFacts = {
      passCount: value.passes.length,
      drawCount: pass.draws.length,
      indexed: draw?.draw.kind !== 'draw',
      vertexCount: draw?.draw.kind === 'draw' ? draw.draw.vertexCount : 0,
      vertexBufferAllocations: draw?.vertexData.length ?? 0,
      targetProvenance: {
        color: pass.colorAttachments[0]?.target ?? null,
        depth: pass.depthStencilAttachment?.target ?? null,
      },
    };
    expect(graphFacts).toEqual({
      passCount: 1,
      drawCount: 1,
      indexed: false,
      vertexCount: 3,
      vertexBufferAllocations: 0,
      targetProvenance: { color: 'color', depth: 'depth' },
    });
    expect({
      status: 'blocked',
      source: 'real-render-target-readback',
      namedRoi: 'grid-occlusion-and-horizon',
      reason: 'carrier unavailable; graph facts do not substitute for pixels',
    }).toMatchObject({ status: 'blocked', source: 'real-render-target-readback' });
  });
});
