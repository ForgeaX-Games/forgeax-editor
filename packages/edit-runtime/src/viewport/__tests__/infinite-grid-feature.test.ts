import { describe, expect, test } from 'bun:test';
import { createSceneDataCatalog, type RenderFeaturePlanContext } from '@forgeax/engine-render';
import { deriveInfiniteGridVisibility } from '../ViewportComponent';
import {
  classifyGridPlane,
  computeGridLod,
  createInfiniteGridFeature,
  intersectGridPlane,
} from '../infinite-grid-feature';

const renderCaps = {
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

const renderTargets = [
    {
      name: 'color',
      kind: 'color',
      format: 'rgba8unorm',
      sampleCount: 1,
    },
    {
      name: 'depth',
      kind: 'depth',
      format: 'depth24plus',
      sampleCount: 1,
    },
] as const;

function renderContext(generation: number): RenderFeaturePlanContext {
  return {
    caps: renderCaps,
    frame: { frameNumber: generation },
    generation,
    targets: renderTargets,
    sceneData: createSceneDataCatalog({
      featureIdentity: 'editor.infinite-grid',
      generation,
      planIdentity: `editor.infinite-grid:${generation}`,
      rgba16floatRenderable: renderCaps.rgba16floatRenderable,
    }),
  };
}

describe('analytic infinite grid math contract', () => {
  test('intersects the selected plane and preserves camera-relative phase', () => {
    const hit = intersectGridPlane(
      { origin: [0, 4, 8], direction: [0, -0.5, -1] },
      'xz',
    );

    expect(hit).toMatchObject({
      worldPosition: [0, 0, 0],
      gridUv: [0, 0],
    });

    const farHit = intersectGridPlane(
      {
        origin: [1_000_000.25, 4, 8],
        direction: [0, -0.5, -1],
        cameraPosition: [1_000_000, 4, 8],
      },
      'xz',
    );
    expect(farHit?.cameraRelativeUv).toEqual([0.25, -8]);
    expect(farHit?.worldPosition[0]).toBe(1_000_000.25);
  });

  test('classifies perspective, six axis-aligned orthographic views, and free oblique orthographic', () => {
    expect(classifyGridPlane({ projection: 'perspective', raySpan: 0.2 })).toBe('xz');
    expect(classifyGridPlane({ projection: 'perspective', raySpan: 1e-6 })).toBe('xz');

    expect(classifyGridPlane({ projection: 'orthographic', viewDirection: [0, 1, 0] })).toBe('xz');
    expect(classifyGridPlane({ projection: 'orthographic', viewDirection: [0, -1, 0] })).toBe('xz');
    expect(classifyGridPlane({ projection: 'orthographic', viewDirection: [1, 0, 0] })).toBe('yz');
    expect(classifyGridPlane({ projection: 'orthographic', viewDirection: [-1, 0, 0] })).toBe('yz');
    expect(classifyGridPlane({ projection: 'orthographic', viewDirection: [0, 0, 1] })).toBe('xy');
    expect(classifyGridPlane({ projection: 'orthographic', viewDirection: [0, 0, -1] })).toBe('xy');
    expect(classifyGridPlane({ projection: 'orthographic', viewDirection: [0.6, 0.6, 0.6] })).toBe('xz');
  });

  test('uses two continuous decimal LOD scales across four decade boundaries', () => {
    const footprints = [0.0001, 0.001, 0.01, 0.1, 1, 10];
    const levels = footprints.map((pixelFootprint) => computeGridLod(pixelFootprint));
    const definedLevels = levels.filter((level): level is NonNullable<typeof level> => level !== null);

    expect(definedLevels).toHaveLength(footprints.length);
    expect(definedLevels.map((level) => level.lowerSpacing)).toEqual([
      0.001,
      0.01,
      0.1,
      1,
      10,
      100,
    ]);
    expect(definedLevels.every((level) => level.upperSpacing === level.lowerSpacing * 10)).toBe(true);
    const lowerTransition = computeGridLod(0.003125);
    const upperTransition = computeGridLod(0.25);
    if (lowerTransition === null || upperTransition === null) throw new Error('valid LOD input returned null');
    expect(lowerTransition.blend).toBeCloseTo(0, 6);
    expect(upperTransition.blend).toBeGreaterThan(0.9);
    expect(computeGridLod(Number.NaN)).toBeNull();
    expect(computeGridLod(Number.POSITIVE_INFINITY)).toBeNull();
  });

  test('fails closed for invalid, parallel, and behind-camera fragments', () => {
    expect(intersectGridPlane({ origin: [0, 1, 0], direction: [1, 0, 0] }, 'xz')).toBeNull();
    expect(intersectGridPlane({ origin: [0, -1, 0], direction: [0, -1, 0] }, 'xz')).toBeNull();
    expect(intersectGridPlane({ origin: [0, Number.NaN, 0], direction: [0, -1, 0] }, 'xz')).toBeNull();
    expect(intersectGridPlane({ origin: [0, 1, 0], direction: [0, Number.POSITIVE_INFINITY, 0] }, 'xz')).toBeNull();
  });
});

describe('public no-vertex RenderFeature plan contract', () => {
  test('binds the grid shader through the canonical view group', () => {
    const feature = createInfiniteGridFeature();
    const extracted = feature.extract({ worlds: [], owner: 0, frameNumber: 1 });
    if (!extracted.ok) throw extracted.error;
    const planned = feature.plan(extracted.value, renderContext(1));
    if (!planned.ok) throw planned.error;
    expect(planned.value.resources).toContainEqual(expect.objectContaining({
      kind: 'graphics-bindings',
      values: { group: 0 },
    }));
  });

  test('declares one fullscreen triangle against logical scene targets', () => {
    const feature = createInfiniteGridFeature();
    expect(feature.requiredMaterialShaders).toEqual(['editor::infinite-grid']);
    const extracted = feature.extract({ worlds: [], owner: 0, frameNumber: 1 });
    if (!extracted.ok) throw extracted.error;
    const result = feature.plan(extracted.value, renderContext(7));
    if (!result.ok) throw result.error;
    expect(result.value.passes).toHaveLength(1);
    expect(result.value.passes[0]).toMatchObject({
      kind: 'raster',
      name: 'editor.infinite-grid',
      colorAttachments: [{ target: 'color', loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { target: 'depth', depthLoadOp: 'load', depthStoreOp: 'store' },
      draws: [{
      vertexLayout: 'none',
      vertexData: [],
        draw: { kind: 'draw', vertexCount: 3, instanceCount: 1 },
      }],
    });
  });

  test('emits zero work while hidden and replans when visible again', () => {
    let visible = true;
    const feature = createInfiniteGridFeature({ isVisible: () => visible });
    const context = renderContext(1);
    const first = feature.extract({ worlds: [], owner: 0, frameNumber: 1 });
    if (!first.ok) throw first.error;
    const visiblePlan = feature.plan(first.value, context);
    if (!visiblePlan.ok) throw visiblePlan.error;
    expect(visiblePlan.value.passes).toHaveLength(1);

    visible = false;
    const hidden = feature.extract({ worlds: [], owner: 0, frameNumber: 2 });
    if (!hidden.ok) throw hidden.error;
    const hiddenPlan = feature.plan(hidden.value, renderContext(2));
    if (!hiddenPlan.ok) throw hiddenPlan.error;
    expect(hiddenPlan.value).toEqual({ resources: [], passes: [] });
  });
});

describe('infinite grid chrome projection', () => {
  test('keeps the preference intact while deriving visibility from Edit phase and scene display', () => {
    expect(deriveInfiniteGridVisibility({ gridVisible: true, display: 'scene', playPhase: 'edit' })).toBe(true);
    expect(deriveInfiniteGridVisibility({
      gridVisible: true,
      display: 'scene',
      playPhase: 'edit',
      sceneHasRenderableContent: false,
    })).toBe(false);
    expect(deriveInfiniteGridVisibility({
      gridVisible: true,
      display: 'scene',
      playPhase: 'edit',
      sceneHasRenderableContent: true,
    })).toBe(true);
    expect(deriveInfiniteGridVisibility({ gridVisible: false, display: 'scene', playPhase: 'edit' })).toBe(false);
    expect(deriveInfiniteGridVisibility({ gridVisible: true, display: 'game', playPhase: 'edit' })).toBe(false);
    expect(deriveInfiniteGridVisibility({ gridVisible: true, display: 'scene', playPhase: 'starting' })).toBe(false);
    expect(deriveInfiniteGridVisibility({ gridVisible: true, display: 'scene', playPhase: 'play' })).toBe(false);
    expect(deriveInfiniteGridVisibility({ gridVisible: true, display: 'scene', playPhase: 'failed' })).toBe(false);
  });
});
