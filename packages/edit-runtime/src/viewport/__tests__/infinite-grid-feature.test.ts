import { describe, expect, test } from 'bun:test';
import { createRenderFeatureHost, runRenderFeatureFrame } from '@forgeax/engine-render/internal';
import { createRenderFeatureTarget } from '@forgeax/engine-render';
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
  createRenderFeatureTarget({
    kind: 'scene-color',
    resource: 'scene-color',
    format: 'rgba8unorm',
    sampleCount: 1,
  }),
  createRenderFeatureTarget({
    kind: 'scene-depth',
    resource: 'scene-depth',
    format: 'depth24plus',
    sampleCount: 1,
  }),
] as const;

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

describe('public no-vertex RenderFeature contribution contract', () => {
  test('contributes one fullscreen triangle into prepared scene targets', () => {
    const feature = createInfiniteGridFeature();
    expect(feature.requiredMaterialShaders).toEqual(['editor::infinite-grid']);
    const host = createRenderFeatureHost([feature]).unwrap();
    const result = runRenderFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 1,
      generation: 7,
      caps: renderCaps,
      targets: renderTargets,
    });

    expect(result.errors).toEqual([]);
    expect(result.contributions).toHaveLength(1);
    expect(result.contributions[0]?.passes).toHaveLength(1);
    expect(result.contributions[0]?.passes[0]?.name).toBe('editor.infinite-grid::editor.infinite-grid');
    expect(result.contributions[0]?.passes[0]?.graphics?.draws).toHaveLength(1);
    expect(result.contributions[0]?.passes[0]?.graphics?.draws[0]).toMatchObject({
      kind: 'draw',
      vertexLayout: 'none',
      vertexData: [],
      command: { vertexCount: 3, instanceCount: 1 },
    });
    expect(host.diagnostics()[0]).toMatchObject({
      identity: 'editor.infinite-grid',
      status: 'active',
      latestError: undefined,
    });
  });

  test('fails closed across hidden, missing-target, and new-generation frames', () => {
    let visible = true;
    const host = createRenderFeatureHost([
      createInfiniteGridFeature({ isVisible: () => visible }),
    ]).unwrap();

    const first = runRenderFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 1,
      generation: 1,
      caps: renderCaps,
      targets: renderTargets,
    });
    expect(first.errors).toEqual([]);
    expect(first.contributions).toHaveLength(1);

    const missingTarget = runRenderFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 2,
      generation: 2,
      caps: renderCaps,
      targets: [renderTargets[0]],
    });
    expect(missingTarget.contributions).toEqual([]);
    expect(missingTarget.errors[0]).toMatchObject({
      code: 'render-feature-preparation-failed',
      detail: { resourceName: 'scene-depth', recovery: 'next-frame' },
    });

    visible = false;
    const hidden = runRenderFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 3,
      generation: 3,
      caps: renderCaps,
      targets: renderTargets,
    });
    expect(hidden.errors).toEqual([]);
    expect(hidden.contributions).toEqual([]);
  });
});

describe('infinite grid chrome projection', () => {
  test('keeps the preference intact while deriving visibility from Edit phase and scene display', () => {
    expect(deriveInfiniteGridVisibility({ gridVisible: true, display: 'scene', playPhase: 'edit' })).toBe(true);
    expect(deriveInfiniteGridVisibility({ gridVisible: false, display: 'scene', playPhase: 'edit' })).toBe(false);
    expect(deriveInfiniteGridVisibility({ gridVisible: true, display: 'game', playPhase: 'edit' })).toBe(false);
    expect(deriveInfiniteGridVisibility({ gridVisible: true, display: 'scene', playPhase: 'starting' })).toBe(false);
    expect(deriveInfiniteGridVisibility({ gridVisible: true, display: 'scene', playPhase: 'play' })).toBe(false);
    expect(deriveInfiniteGridVisibility({ gridVisible: true, display: 'scene', playPhase: 'failed' })).toBe(false);
  });
});
