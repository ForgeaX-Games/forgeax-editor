// gizmo-render-feature — filled editor-chrome pass.
//
// Transform and parameter Gizmos are frame-local presentation, not authored
// scene state. This feature draws their already-projected triangles after the
// scene color pass, with no depth attachment, so opaque scene geometry cannot
// occlude the handles and the visual result remains solid like the original
// editor-world mesh implementation.

import {
  type RenderFeature,
  type RenderFeaturePlan,
  type RenderFeaturePlanContext,
} from '@forgeax/engine-render';
import { ok } from '@forgeax/engine-types';

import './shaders/gizmo-overlay.wgsl';

export const GIZMO_RENDER_FEATURE_ID = 'editor.gizmo-overlay';
export const GIZMO_RENDER_PASS_NAME = 'editor.gizmo-overlay';
export const GIZMO_RENDER_SHADER_ID = 'editor::gizmo-overlay';
export const GIZMO_RENDER_VERTEX_LAYOUT = 'editor-gizmo-overlay';

/** Position (NDC xyz), unused mesh attributes, and color (RGBA). */
export const GIZMO_VERTEX_STRIDE_FLOATS = 12;
const GIZMO_VERTEX_STRIDE_BYTES = GIZMO_VERTEX_STRIDE_FLOATS * Float32Array.BYTES_PER_ELEMENT;

// Translate/rotate/scale handles plus a camera frustum can fit comfortably in
// this fixed-size stream. Keeping the allocation stable is important because
// RenderFeature GPU buffers reject per-frame size changes by design.
export const GIZMO_MAX_VERTEX_COUNT = 16_384;
const GIZMO_BUFFER_BYTES = GIZMO_MAX_VERTEX_COUNT * GIZMO_VERTEX_STRIDE_BYTES;

export interface GizmoRenderFeatureOptions {
  /** NDC-ready vertices using the editor's stable 48-byte render-material layout. */
  readonly getVertexData: () => Float32Array;
  /** Render only while the editor viewport owns the scene presentation. */
  readonly isVisible?: () => boolean;
}

interface GizmoRenderFrame {
  readonly visible: boolean;
  readonly vertices: Float32Array;
}

function emptyPlan(): RenderFeaturePlan {
  return { resources: [], passes: [] };
}

function createGizmoPlan(
  data: GizmoRenderFrame,
  context: RenderFeaturePlanContext,
): RenderFeaturePlan {
  const colorTarget = context.targets.find((target) => target.name === 'color');
  const program = 'editor.gizmo-overlay.program';
  const bindings = 'editor.gizmo-overlay.bindings';
  const vertexBuffer = 'editor.gizmo-overlay.buffer';
  const vertexData = 'editor.gizmo-overlay.vertices';
  const vertexCount = Math.floor(data.vertices.length / GIZMO_VERTEX_STRIDE_FLOATS);

  return {
    resources: [
      {
        kind: 'graphics-program',
        name: program,
        program: {
          shader: GIZMO_RENDER_SHADER_ID,
          vertexLayout: GIZMO_RENDER_VERTEX_LAYOUT,
          colorFormats: [colorTarget?.format ?? 'rgba16float'],
          sampleCount: colorTarget?.sampleCount ?? 1,
          topology: 'triangle-list',
          renderState: {
            cullMode: 'none',
            depthCompare: 'always',
            depthWriteEnabled: false,
          },
        },
      },
      {
        kind: 'graphics-bindings',
        name: bindings,
        program,
        // The shader has no authored/material resources. group:0 selects the
        // renderer-owned empty bind group for this color-only overlay.
        values: { group: 0 },
      },
      {
        kind: 'buffer',
        name: vertexBuffer,
        size: GIZMO_BUFFER_BYTES,
        usage: ['vertex'],
        data: data.vertices,
      },
      {
        kind: 'vertex-data',
        name: vertexData,
        layout: GIZMO_RENDER_VERTEX_LAYOUT,
        buffer: vertexBuffer,
      },
    ],
    passes: [
      {
        kind: 'raster',
        name: GIZMO_RENDER_PASS_NAME,
        // Loading/storing the logical scene color makes this a genuine
        // scene-after pass instead of an independent editor surface.
        colorAttachments: [{ target: 'color', loadOp: 'load', storeOp: 'store' }],
        draws: [
          {
            program,
            bindings: [bindings],
            vertexData: [{ slot: 0, resource: vertexData }],
            draw: { kind: 'draw', vertexCount, instanceCount: 1 },
          },
        ],
      },
    ],
  };
}

export function createGizmoRenderFeature(
  options: GizmoRenderFeatureOptions,
): RenderFeature<GizmoRenderFrame> {
  return {
    identity: GIZMO_RENDER_FEATURE_ID,
    requiredMaterialShaders: [GIZMO_RENDER_SHADER_ID],
    extract: () => {
      const visible = options.isVisible?.() ?? true;
      const vertices = visible ? options.getVertexData() : new Float32Array(0);
      if (vertices.length > GIZMO_MAX_VERTEX_COUNT * GIZMO_VERTEX_STRIDE_FLOATS) {
        return ok({
          visible: true,
          vertices: vertices.subarray(0, GIZMO_MAX_VERTEX_COUNT * GIZMO_VERTEX_STRIDE_FLOATS),
        });
      }
      return ok({ visible, vertices });
    },
    plan: (data, context) => ok(
      data.visible && data.vertices.length > 0
        ? createGizmoPlan(data, context)
        : emptyPlan(),
    ),
  };
}
