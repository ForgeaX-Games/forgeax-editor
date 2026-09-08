import {
  type RenderFeature,
  type RenderFeaturePlan,
  type RenderFeaturePlanContext,
} from '@forgeax/engine-render';
import { ok } from '@forgeax/engine-types';
import './shaders/infinite-grid.wgsl';

export const INFINITE_GRID_FEATURE_ID = 'editor.infinite-grid';
export const INFINITE_GRID_PASS_NAME = 'editor.infinite-grid';
export const INFINITE_GRID_SHADER_ID = 'editor::infinite-grid';

export type GridPlane = 'xz' | 'xy' | 'yz';
export type Vec3 = readonly [number, number, number];
export type Vec2 = readonly [number, number];

export interface GridRay {
  readonly origin: Vec3;
  readonly direction: Vec3;
  readonly cameraPosition?: Vec3;
}

export interface GridIntersection {
  readonly worldPosition: Vec3;
  readonly gridUv: Vec2;
  readonly cameraRelativeUv: Vec2;
  readonly distance: number;
}

export interface GridLod {
  readonly logarithmicLevel: number;
  readonly lowerSpacing: number;
  readonly upperSpacing: number;
  readonly blend: number;
}

export type GridProjection =
  | { readonly projection: 'perspective'; readonly raySpan: number }
  | { readonly projection: 'orthographic'; readonly viewDirection: Vec3 };

const PLANE_EPSILON = 1e-6;
const ORTHOGRAPHIC_AXIS_THRESHOLD = 0.9995;

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function finiteVec3(value: Vec3): boolean {
  return value.every(finite);
}

function planeBasis(plane: GridPlane): { readonly normal: Vec3; readonly u: Vec3; readonly v: Vec3 } {
  switch (plane) {
    case 'xz':
      return { normal: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1] };
    case 'xy':
      return { normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] };
    case 'yz':
      return { normal: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] };
  }
}

function dot(left: Vec3, right: Vec3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function subtract(left: Vec3, right: Vec3): Vec3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function addScaled(origin: Vec3, direction: Vec3, scale: number): Vec3 {
  return [
    origin[0] + direction[0] * scale,
    origin[1] + direction[1] * scale,
    origin[2] + direction[2] * scale,
  ];
}

function project(value: Vec3, axis: Vec3): number {
  return dot(value, axis);
}

function positiveMod(value: number, modulus: number): number {
  return value - Math.floor(value / modulus) * modulus;
}

export function intersectGridPlane(ray: GridRay, plane: GridPlane): GridIntersection | null {
  if (!finiteVec3(ray.origin) || !finiteVec3(ray.direction)) return null;
  const basis = planeBasis(plane);
  const denominator = dot(ray.direction, basis.normal);
  if (!finite(denominator) || Math.abs(denominator) < PLANE_EPSILON) return null;
  const distance = -dot(ray.origin, basis.normal) / denominator;
  if (!finite(distance) || distance <= PLANE_EPSILON) return null;
  const worldPosition = addScaled(ray.origin, ray.direction, distance);
  if (!finiteVec3(worldPosition)) return null;
  const gridUv: Vec2 = [project(worldPosition, basis.u), project(worldPosition, basis.v)];
  const cameraPosition = ray.cameraPosition ?? ray.origin;
  if (!finiteVec3(cameraPosition)) return null;
  const local = subtract(worldPosition, cameraPosition);
  const cameraUv: Vec2 = [project(cameraPosition, basis.u), project(cameraPosition, basis.v)];
  const localUv: Vec2 = [project(local, basis.u), project(local, basis.v)];
  const cameraRelativeUv: Vec2 = [
    localUv[0] + positiveMod(cameraUv[0], 1),
    localUv[1] + positiveMod(cameraUv[1], 1),
  ];
  return { worldPosition, gridUv, cameraRelativeUv, distance };
}

export function classifyGridPlane(projection: GridProjection): GridPlane {
  if (projection.projection === 'perspective') return 'xz';
  const direction = projection.viewDirection;
  if (!finiteVec3(direction)) return 'xz';
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  if (!finite(length) || length < PLANE_EPSILON) return 'xz';
  const normalized: Vec3 = [direction[0] / length, direction[1] / length, direction[2] / length];
  const absolute: Vec3 = [Math.abs(normalized[0]), Math.abs(normalized[1]), Math.abs(normalized[2])];
  if (absolute[1] >= ORTHOGRAPHIC_AXIS_THRESHOLD) return 'xz';
  if (absolute[0] >= ORTHOGRAPHIC_AXIS_THRESHOLD) return 'yz';
  if (absolute[2] >= ORTHOGRAPHIC_AXIS_THRESHOLD) return 'xy';
  return 'xz';
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function computeGridLod(pixelFootprint: number): GridLod | null {
  if (!finite(pixelFootprint) || pixelFootprint <= 0) return null;
  const logarithmicLevel = Math.log10(Math.max(pixelFootprint * 32, 1e-6));
  if (!finite(logarithmicLevel)) return null;
  const lowerSpacing = 10 ** Math.floor(logarithmicLevel);
  const upperSpacing = lowerSpacing * 10;
  const blend = smoothstep(0.2, 0.8, logarithmicLevel - Math.floor(logarithmicLevel));
  if (![lowerSpacing, upperSpacing, blend].every(finite)) return null;
  return { logarithmicLevel, lowerSpacing, upperSpacing, blend };
}

interface InfiniteGridFrame {
  readonly visible: boolean;
}

interface InfiniteGridFeatureOptions {
  readonly isVisible?: () => boolean;
}

function createInfiniteGridPlan(context: RenderFeaturePlanContext): RenderFeaturePlan {
  const colorTarget = context.targets.find((target) => target.name === 'color');
  const depthTarget = context.targets.find((target) => target.name === 'depth');
  const program = 'editor.infinite-grid.program';
  const bindings = 'editor.infinite-grid.bindings';
  return {
    resources: [
      {
        kind: 'graphics-program',
        name: program,
        program: {
          shader: INFINITE_GRID_SHADER_ID,
          vertexLayout: 'none',
          colorFormats: [colorTarget?.format ?? 'rgba16float'],
          depthFormat: depthTarget?.format ?? 'depth24plus',
          sampleCount: colorTarget?.sampleCount ?? 1,
          topology: 'triangle-list',
          renderState: {
            cullMode: 'none',
            // Keep the grid behind any geometry that owns the same or a nearer
            // depth. The grid is viewport chrome, not an overlay that should
            // win a depth tie against authored geometry.
            depthCompare: 'less',
            depthWriteEnabled: false,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        },
      },
      {
        kind: 'graphics-bindings',
        name: bindings,
        program,
        // The shader imports the shared `forgeax_view` UBO and does not declare
        // a depth-texture binding. The depth target remains an attachment (and
        // is therefore part of graph topology), but must not be projected as a
        // group-0 resource; doing so asks the graph resolver to bind a texture
        // view against `pbr-view-bgl` and invalidates the first frame.
        values: { group: 0 },
      },
    ],
    passes: [
      {
        kind: 'raster',
        name: INFINITE_GRID_PASS_NAME,
        colorAttachments: [{ target: 'color', loadOp: 'load', storeOp: 'store' }],
        depthStencilAttachment: {
          target: 'depth',
          depthLoadOp: 'load',
          depthStoreOp: 'store',
        },
        draws: [
          {
            program,
            bindings: [bindings],
            vertexData: [],
            vertexLayout: 'none',
            draw: { kind: 'draw', vertexCount: 3, instanceCount: 1 },
          },
        ],
      },
    ],
  };
}

export function createInfiniteGridFeature(
  options: InfiniteGridFeatureOptions = {},
): RenderFeature<InfiniteGridFrame> {
  return {
    identity: INFINITE_GRID_FEATURE_ID,
    requiredMaterialShaders: [INFINITE_GRID_SHADER_ID],
    extract: () => ok({ visible: options.isVisible?.() ?? true }),
    plan: (data, context) => ok(data.visible ? createInfiniteGridPlan(context) : { resources: [], passes: [] }),
  };
}
