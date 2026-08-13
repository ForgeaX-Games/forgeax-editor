import {
  RenderFeaturePreparationFailedError,
  RenderFeaturePreparedStateMismatchError,
  type RenderFeature,
  type RenderFeaturePreparedRef,
  type RenderFeatureTargetHandle,
  type Renderer,
} from '@forgeax/engine-render';
import { err, ok, type Result } from '@forgeax/engine-types';

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

function unavailable(
  operation: string,
  resourceKind: 'pipeline' | 'bindings' | 'attachment',
  resourceName: string,
  reason = 'required scene target is unavailable',
): Result<never, import('@forgeax/engine-render').RenderError> {
  return err(
    new RenderFeaturePreparationFailedError(
      INFINITE_GRID_FEATURE_ID,
      0,
      operation,
      resourceKind,
      resourceName,
      reason,
      'next-frame',
    ),
  );
}

function findTarget(
  targets: readonly RenderFeatureTargetHandle[],
  kind: RenderFeatureTargetHandle['kind'],
): RenderFeatureTargetHandle | undefined {
  return targets.find((target) => target.kind === kind);
}

function targetSignature(
  colorTarget: RenderFeatureTargetHandle,
  depthTarget: RenderFeatureTargetHandle,
): string {
  return [colorTarget, depthTarget]
    .map((target) => `${target.kind}:${target.resource}:${target.format}:${target.sampleCount}`)
    .join('|');
}

export function createInfiniteGridFeature(
  options: InfiniteGridFeatureOptions = {},
): RenderFeature<InfiniteGridFrame> {
  let pipeline: RenderFeaturePreparedRef<'pipeline'> | undefined;
  let bindings: RenderFeaturePreparedRef<'bindings'> | undefined;
  let colorTarget: RenderFeatureTargetHandle | undefined;
  let depthTarget: RenderFeatureTargetHandle | undefined;
  let preparedTargetSignature: string | undefined;

  const clearPreparedState = (): void => {
    pipeline = undefined;
    bindings = undefined;
    colorTarget = undefined;
    depthTarget = undefined;
    preparedTargetSignature = undefined;
  };

  return {
    identity: INFINITE_GRID_FEATURE_ID,
    requiredMaterialShaders: [INFINITE_GRID_SHADER_ID],
    extract: () => ok({ visible: options.isVisible?.() ?? true }),
    prepare: (data, context) => {
      clearPreparedState();
      if (!data.visible) return ok(undefined);

      const nextColorTarget = findTarget(context.targets, 'scene-color');
      const nextDepthTarget = findTarget(context.targets, 'scene-depth');
      if (nextColorTarget === undefined) return unavailable('find-scene-color', 'attachment', 'scene-color');
      if (nextDepthTarget === undefined) return unavailable('find-scene-depth', 'attachment', 'scene-depth');
      if (nextColorTarget.sampleCount !== nextDepthTarget.sampleCount) {
        return unavailable(
          'validate-scene-targets',
          'attachment',
          'scene-depth',
          'scene color/depth sample count mismatch',
        );
      }
      const preparedPipeline = context.graphics.preparePipeline('infinite-grid-pipeline', {
        shader: INFINITE_GRID_SHADER_ID,
        vertexLayout: 'none',
        colorFormats: [nextColorTarget.format],
        depthFormat: nextDepthTarget.format,
        sampleCount: nextColorTarget.sampleCount,
        topology: 'triangle-list',
        renderState: {
          cullMode: 'none',
          depthCompare: 'less',
          depthWriteEnabled: false,
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        },
      });
      if (!preparedPipeline.ok) return preparedPipeline;
      const preparedBindings = context.graphics.prepareBindings('infinite-grid-view', {
        pipeline: preparedPipeline.value,
        values: { group: 0, sceneDepth: nextDepthTarget },
      });
      if (!preparedBindings.ok) return preparedBindings;
      pipeline = preparedPipeline.value;
      bindings = preparedBindings.value;
      colorTarget = nextColorTarget;
      depthTarget = nextDepthTarget;
      preparedTargetSignature = targetSignature(nextColorTarget, nextDepthTarget);
      return ok(undefined);
    },
    contribute: (data, context) => {
      if (!data.visible) return ok(undefined);
      if (pipeline === undefined || bindings === undefined || colorTarget === undefined || depthTarget === undefined) {
        return unavailable('contribute', 'pipeline', 'infinite-grid-pipeline');
      }
      if (pipeline.generation !== bindings.generation) {
        return err(new RenderFeaturePreparedStateMismatchError({
          featureIdentity: INFINITE_GRID_FEATURE_ID,
          order: 0,
          stage: 'contribute',
          operation: 'validate-prepared-generation',
          resourceKind: 'bindings',
          reason: 'generation-mismatch',
          expectedGeneration: pipeline.generation,
          actualGeneration: bindings.generation,
          recovery: 'next-frame',
        }));
      }
      const activeColorTarget = findTarget(context.targets, 'scene-color');
      const activeDepthTarget = findTarget(context.targets, 'scene-depth');
      if (activeColorTarget === undefined || activeDepthTarget === undefined) {
        return unavailable('contribute-targets', 'attachment', 'scene-color');
      }
      if (preparedTargetSignature !== targetSignature(activeColorTarget, activeDepthTarget)) {
        return err(new RenderFeaturePreparedStateMismatchError({
          featureIdentity: INFINITE_GRID_FEATURE_ID,
          order: 0,
          stage: 'contribute',
          operation: 'validate-prepared-targets',
          resourceKind: 'attachment',
          reason: 'format-mismatch',
          expectedFormat: preparedTargetSignature ?? 'prepared-targets',
          actualFormat: targetSignature(activeColorTarget, activeDepthTarget),
          recovery: 'next-frame',
        }));
      }
      return context.staging.addGraphicsPass(INFINITE_GRID_PASS_NAME, {
        attachments: {
          colors: [{ resource: colorTarget, format: colorTarget.format, loadOp: 'load', storeOp: 'store' }],
          depthStencil: {
            resource: depthTarget,
            format: depthTarget.format,
            depthLoadOp: 'load',
            depthStoreOp: 'store',
          },
        },
        draws: [{
          kind: 'draw',
          pipeline,
          bindings: [bindings],
          vertexData: [],
          vertexLayout: 'none',
          command: { vertexCount: 3, instanceCount: 1 },
        }],
      });
    },
    recover: () => {
      clearPreparedState();
      return ok(undefined);
    },
  };
}

export async function installInfiniteGridShader(renderer: Pick<Renderer, 'shader'>): Promise<void> {
  const artifact = await import('./shaders/infinite-grid.wgsl');
  const source = artifact.default.wgsl;
  const existing = renderer.shader.findMaterialArtifact(INFINITE_GRID_SHADER_ID);
  if (existing.ok) {
    if (existing.value.source !== source || existing.value.paramSchema.length !== 0) {
      throw new Error(`ShaderRegistry: existing '${INFINITE_GRID_SHADER_ID}' artifact does not match the current infinite-grid shader`);
    }
    return;
  }
  renderer.shader.installMaterialArtifact(INFINITE_GRID_SHADER_ID, {
    source,
    paramSchema: [],
  });
}
