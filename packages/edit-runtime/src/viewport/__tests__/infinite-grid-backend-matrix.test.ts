import { describe, expect, it } from 'bun:test';
import { createRenderFeatureHost, runRenderFeatureFrame } from '@forgeax/engine-render/internal';
import { createRenderFeatureTarget } from '@forgeax/engine-render';
import { createInfiniteGridFeature } from '../infinite-grid-feature';

type BackendCase = {
  readonly name: string;
  readonly backendKind: 'webgpu' | 'wgpu-webgl2' | 'null';
  readonly colorFormat: string;
  readonly depthFormat: string;
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

function targets(testCase: BackendCase) {
  return [
    createRenderFeatureTarget({
      kind: 'scene-color',
      resource: `scene-color-${testCase.name}`,
      format: testCase.colorFormat,
      sampleCount: testCase.sampleCount,
    }),
    createRenderFeatureTarget({
      kind: 'scene-depth',
      resource: `scene-depth-${testCase.name}`,
      format: testCase.depthFormat,
      sampleCount: testCase.sampleCount,
    }),
  ] as const;
}

function run(testCase: BackendCase, includeDepth = true) {
  const host = createRenderFeatureHost([createInfiniteGridFeature()]).unwrap();
  const result = runRenderFeatureFrame(host, {
    worlds: [],
    owner: 0,
    frameNumber: 1,
    generation: 1,
    caps: caps(testCase.backendKind),
    targets: includeDepth ? targets(testCase) : [targets(testCase)[0]],
  });
  const pass = result.contributions[0]?.passes[0];
  return {
    backendKind: testCase.backendKind,
    passName: pass?.name ?? null,
    reads: pass?.descriptor.reads ?? [],
    writes: pass?.descriptor.writes ?? [],
    draw: pass?.graphics?.draws[0]?.command ?? null,
    error: result.errors[0] === undefined
      ? null
      : {
          code: result.errors[0].code,
          recovery: 'detail' in result.errors[0] && 'recovery' in result.errors[0].detail
            ? result.errors[0].detail.recovery
            : undefined,
          resourceName: 'detail' in result.errors[0] && 'resourceName' in result.errors[0].detail
            ? result.errors[0].detail.resourceName
            : undefined,
        },
  };
}

describe('infinite grid backend contract matrix', () => {
  it('keeps the same public feature contract across declared backend/pipeline cases', () => {
    const results = backendCases.map((testCase) => run(testCase));

    expect(results).toEqual(backendCases.map((testCase) => ({
      backendKind: testCase.backendKind,
      passName: 'editor.infinite-grid::editor.infinite-grid',
      reads: [`scene-depth-${testCase.name}`],
      writes: [`scene-color-${testCase.name}`],
      draw: { vertexCount: 3, instanceCount: 1 },
      error: null,
    })));
  });

  it('projects unavailable target capability as the same structured recovery result', () => {
    const failures = backendCases.map((testCase) => run(testCase, false));

    expect(failures).toEqual(backendCases.map((testCase) => ({
      backendKind: testCase.backendKind,
      passName: null,
      reads: [],
      writes: [],
      draw: null,
      error: {
        code: 'render-feature-preparation-failed',
        recovery: 'next-frame',
        resourceName: 'scene-depth',
      },
    })));
  });
});
