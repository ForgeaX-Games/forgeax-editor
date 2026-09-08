import { describe, expect, it } from 'bun:test';
import type { RenderFeaturePlanContext } from '@forgeax/engine-render';

import {
  createGizmoRenderFeature,
  GIZMO_MAX_VERTEX_COUNT,
  GIZMO_RENDER_SHADER_ID,
  GIZMO_RENDER_VERTEX_LAYOUT,
} from '../gizmo-render-feature';

const context = {
  targets: [
    { name: 'color', kind: 'color', format: 'rgba8unorm', sampleCount: 1 },
  ],
} as unknown as RenderFeaturePlanContext;

function extractPlan(feature: ReturnType<typeof createGizmoRenderFeature>) {
  const extracted = feature.extract({ worlds: [], owner: 0, frameNumber: 1 });
  if (!extracted.ok) throw extracted.error;
  const planned = feature.plan(extracted.value, context);
  if (!planned.ok) throw planned.error;
  return planned.value;
}

describe('filled Gizmo scene-after RenderFeature', () => {
  it('uses a stable triangle stream and loads/stores the scene color target', () => {
    const vertices = new Float32Array(36);
    const feature = createGizmoRenderFeature({
      getVertexData: () => vertices,
    });
    const plan = extractPlan(feature);

    expect(feature.requiredMaterialShaders).toEqual([GIZMO_RENDER_SHADER_ID]);
    const program = plan.resources.find((resource) => resource.kind === 'graphics-program');
    const buffer = plan.resources.find((resource) => resource.kind === 'buffer');
    const vertexData = plan.resources.find((resource) => resource.kind === 'vertex-data');
    expect(program).toMatchObject({
      kind: 'graphics-program',
      program: {
        vertexLayout: GIZMO_RENDER_VERTEX_LAYOUT,
        topology: 'triangle-list',
        renderState: {
          cullMode: 'none',
          depthCompare: 'always',
          depthWriteEnabled: false,
        },
      },
    });
    expect((program as { program?: { depthFormat?: unknown } }).program).not.toHaveProperty('depthFormat');
    expect(buffer).toMatchObject({
      kind: 'buffer',
      size: GIZMO_MAX_VERTEX_COUNT * 12 * Float32Array.BYTES_PER_ELEMENT,
      usage: ['vertex'],
      data: vertices,
    });
    expect(vertexData).toMatchObject({
      kind: 'vertex-data',
      layout: GIZMO_RENDER_VERTEX_LAYOUT,
    });
    expect(plan.passes).toHaveLength(1);
    const pass = plan.passes[0]!;
    expect(pass).toMatchObject({
      kind: 'raster',
      name: 'editor.gizmo-overlay',
      colorAttachments: [{ target: 'color', loadOp: 'load', storeOp: 'store' }],
      draws: [{
        vertexData: [{ slot: 0, resource: 'editor.gizmo-overlay.vertices' }],
        draw: { kind: 'draw', vertexCount: 3, instanceCount: 1 },
      }],
    });
    expect(pass).not.toHaveProperty('depthStencilAttachment');
  });

  it('emits no pass while hidden or when there is no selected chrome', () => {
    let visible = true;
    let vertices = new Float32Array(0);
    const feature = createGizmoRenderFeature({
      getVertexData: () => vertices,
      isVisible: () => visible,
    });

    expect(extractPlan(feature)).toEqual({ resources: [], passes: [] });
    vertices = new Float32Array(12);
    expect(extractPlan(feature).passes).toHaveLength(1);
    visible = false;
    expect(extractPlan(feature)).toEqual({ resources: [], passes: [] });
  });
});
