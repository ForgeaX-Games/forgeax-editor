import { describe, expect, it } from 'bun:test';
import { type RenderFeaturePlanContext } from '@forgeax/engine-render';
import { createInfiniteGridFeature } from '../infinite-grid-feature';

type BackendCase = {
  readonly name: string;
  readonly backendKind: 'webgpu' | 'wgpu-webgl2' | 'null';
  readonly colorFormat: 'rgba16float' | 'rgba8unorm';
  readonly depthFormat: 'depth24plus-stencil8' | 'depth24plus' | 'depth32float';
  readonly sampleCount: 1 | 4;
};

const backendCases: readonly BackendCase[] = [
  { name: 'WebGPU URP', backendKind: 'webgpu', colorFormat: 'rgba16float', depthFormat: 'depth24plus-stencil8', sampleCount: 4 },
  { name: 'WebGL2 fallback URP', backendKind: 'wgpu-webgl2', colorFormat: 'rgba8unorm', depthFormat: 'depth24plus', sampleCount: 1 },
  { name: 'WebGPU HDRP', backendKind: 'webgpu', colorFormat: 'rgba16float', depthFormat: 'depth32float', sampleCount: 1 },
  { name: 'null contract carrier', backendKind: 'null', colorFormat: 'rgba8unorm', depthFormat: 'depth24plus', sampleCount: 1 },
];

const caps = (backendKind: BackendCase['backendKind']) => ({
  backendKind,
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
} as const);

function run(testCase: BackendCase) {
  const feature = createInfiniteGridFeature();
  const extracted = feature.extract({ worlds: [], owner: 0, frameNumber: 1 });
  if (!extracted.ok) throw extracted.error;
  const context: RenderFeaturePlanContext = {
    caps: caps(testCase.backendKind),
    frame: { frameNumber: 1 },
    generation: 1,
    targets: [
      { name: 'color', kind: 'color', format: testCase.colorFormat, sampleCount: testCase.sampleCount },
      { name: 'depth', kind: 'depth', format: testCase.depthFormat, sampleCount: testCase.sampleCount },
    ],
  };
  const result = feature.plan(extracted.value, context);
  if (!result.ok) throw result.error;
  const program = result.value.resources.find((resource) => resource.kind === 'graphics-program');
  const pass = result.value.passes[0];
  return {
    backendKind: testCase.backendKind,
    colorFormats: program?.kind === 'graphics-program' ? program.program.colorFormats : [],
    depthFormat: program?.kind === 'graphics-program' ? program.program.depthFormat : undefined,
    sampleCount: program?.kind === 'graphics-program' ? program.program.sampleCount : undefined,
    colorTarget: pass?.kind === 'raster' ? pass.colorAttachments[0]?.target : undefined,
    depthTarget: pass?.kind === 'raster' ? pass.depthStencilAttachment?.target : undefined,
    draw: pass?.kind === 'raster' ? pass.draws[0]?.draw : undefined,
  };
}

describe('infinite grid backend contract matrix', () => {
  it('keeps one public declarative feature contract across backend and pipeline cases', () => {
    expect(backendCases.map(run)).toEqual(backendCases.map((testCase) => ({
      backendKind: testCase.backendKind,
      colorFormats: [testCase.colorFormat],
      depthFormat: testCase.depthFormat,
      sampleCount: testCase.sampleCount,
      colorTarget: 'color',
      depthTarget: 'depth',
      draw: { kind: 'draw', vertexCount: 3, instanceCount: 1 },
    })));
  });
});
