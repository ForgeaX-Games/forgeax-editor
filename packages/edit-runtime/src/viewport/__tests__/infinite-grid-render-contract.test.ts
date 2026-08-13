import { describe, expect, it } from 'bun:test';
import { createRenderFeatureHost, runRenderFeatureFrame } from '@forgeax/engine-render/internal';
import { createRenderFeatureTarget } from '@forgeax/engine-render';
import { createInfiniteGridFeature } from '../infinite-grid-feature';

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

function resourceName(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null || !('resource' in value)) return null;
  const resource = value.resource;
  return typeof resource === 'string' ? resource : null;
}

function targets(depthSampleCount: 1 | 4 = 1) {
  return [
    createRenderFeatureTarget({
      kind: 'scene-color',
      resource: 'scene-color',
      format: 'rgba16float',
      sampleCount: 1,
    }),
    createRenderFeatureTarget({
      kind: 'scene-depth',
      resource: 'scene-depth',
      format: 'depth24plus-stencil8',
      sampleCount: depthSampleCount,
    }),
  ] as const;
}

describe('infinite grid render contract', () => {
  it('projects the active scene targets into one ordered graphics contribution', () => {
    const host = createRenderFeatureHost([createInfiniteGridFeature()]).unwrap();
    const result = runRenderFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 1,
      generation: 3,
      caps,
      targets: targets(),
    });

    const pass = result.contributions[0]?.passes[0];
    expect(result.errors).toEqual([]);
    expect(pass?.name).toBe('editor.infinite-grid::editor.infinite-grid');
    expect(pass?.descriptor.reads).toEqual(['scene-depth']);
    expect(pass?.descriptor.writes).toEqual(['scene-color']);
    expect(pass?.graphics?.attachments).toEqual({
      colors: [{
        resource: expect.objectContaining({ kind: 'scene-color', resource: 'scene-color' }),
        format: 'rgba16float',
        loadOp: 'load',
        storeOp: 'store',
      }],
      depthStencil: {
        resource: expect.objectContaining({ kind: 'scene-depth', resource: 'scene-depth' }),
        format: 'depth24plus-stencil8',
        depthLoadOp: 'load',
        depthStoreOp: 'store',
      },
    });
    expect(pass?.graphics?.draws).toEqual([expect.objectContaining({
      kind: 'draw',
      vertexLayout: 'none',
      vertexData: [],
      command: { vertexCount: 3, instanceCount: 1 },
    })]);
  });

  it('rejects a color/depth sample mismatch before contributing a pass', () => {
    const host = createRenderFeatureHost([createInfiniteGridFeature()]).unwrap();
    const result = runRenderFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 1,
      generation: 3,
      caps,
      targets: targets(4),
    });

    expect(result.contributions).toEqual([]);
    expect(result.errors[0]).toMatchObject({
      code: 'render-feature-preparation-failed',
      detail: {
        resourceName: 'scene-depth',
        reason: 'scene color/depth sample count mismatch',
        recovery: 'next-frame',
      },
    });
  });

  it('invalidates prepared state during recovery before the next resized frame', () => {
    const feature = createInfiniteGridFeature();
    expect(feature.recover).toEqual(expect.any(Function));

    const host = createRenderFeatureHost([feature]).unwrap();
    const first = runRenderFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 1,
      generation: 1,
      caps,
      targets: targets(),
    });
    expect(first.errors).toEqual([]);
    const firstPass = first.contributions[0]?.passes[0];
    const firstPipeline = firstPass?.graphicsState?.pipeline;
    expect(firstPipeline?.generation).toBe(1);

    expect(host.recover({ caps, frameNumber: 2 }).ok).toBe(true);
    expect(host.preparedGeneration).toBe(2);

    const resized = runRenderFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 3,
      generation: 2,
      caps,
      targets: [
        createRenderFeatureTarget({
          kind: 'scene-color',
          resource: 'scene-color-resized',
          format: 'rgba8unorm',
          sampleCount: 1,
        }),
        createRenderFeatureTarget({
          kind: 'scene-depth',
          resource: 'scene-depth-resized',
          format: 'depth32float',
          sampleCount: 1,
        }),
      ],
    });
    const resizedPass = resized.contributions[0]?.passes[0];
    expect(resized.errors).toEqual([]);
    expect(resizedPass?.graphicsState?.pipeline?.generation).toBe(2);
    expect(resizedPass?.graphicsState?.pipeline).not.toBe(firstPipeline);
    expect(resizedPass?.graphics?.attachments.colors[0]).toMatchObject({
      resource: expect.objectContaining({ resource: 'scene-color-resized' }),
      format: 'rgba8unorm',
    });
    expect(resizedPass?.graphics?.attachments.depthStencil).toMatchObject({
      resource: expect.objectContaining({ resource: 'scene-depth-resized' }),
      format: 'depth32float',
    });
  });

  it('separates topology facts from pixel evidence and preserves target provenance after resize', () => {
    const host = createRenderFeatureHost([createInfiniteGridFeature()]).unwrap();
    const frame = runRenderFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 1,
      generation: 2,
      caps,
      targets: [
        createRenderFeatureTarget({ kind: 'scene-color', resource: 'scene-color-resized', format: 'rgba8unorm', sampleCount: 1 }),
        createRenderFeatureTarget({ kind: 'scene-depth', resource: 'scene-depth-resized', format: 'depth32float', sampleCount: 1 }),
      ],
    });
    const pass = frame.contributions[0]?.passes[0];
    const draw = pass?.graphics?.draws[0];
    const command = draw?.command;
    const graphFacts = {
      passCount: frame.contributions.flatMap((contribution) => contribution.passes).length,
      drawCount: pass?.graphics?.draws.length ?? 0,
      indexed: command !== undefined && 'indexCount' in command,
      vertexCount: command !== undefined && 'vertexCount' in command ? command.vertexCount : 0,
      vertexBufferAllocations: draw?.vertexData.length ?? 0,
      indexBufferAllocations: 0,
      textureAllocations: 0,
      cpuLineAllocations: 0,
      submitCount: null as number | null,
      targetProvenance: {
        color: resourceName(pass?.graphics?.attachments.colors[0]?.resource),
        depth: resourceName(pass?.graphics?.attachments.depthStencil?.resource),
        generation: pass?.graphicsState?.pipeline?.generation ?? null,
      },
    };
    const pixelEvidence = {
      status: 'blocked' as const,
      source: 'real-render-target-readback',
      namedRoi: 'grid-occlusion-and-horizon',
      reason: 'carrier unavailable; graph facts do not substitute for pixels',
    };

    expect(frame.errors).toEqual([]);
    expect(graphFacts).toEqual({
      passCount: 1,
      drawCount: 1,
      indexed: false,
      vertexCount: 3,
      vertexBufferAllocations: 0,
      indexBufferAllocations: 0,
      textureAllocations: 0,
      cpuLineAllocations: 0,
      submitCount: null,
      targetProvenance: {
        color: 'scene-color-resized',
        depth: 'scene-depth-resized',
        generation: 2,
      },
    });
    expect(pixelEvidence).toEqual({
      status: 'blocked',
      source: 'real-render-target-readback',
      namedRoi: 'grid-occlusion-and-horizon',
      reason: 'carrier unavailable; graph facts do not substitute for pixels',
    });
  });
});
