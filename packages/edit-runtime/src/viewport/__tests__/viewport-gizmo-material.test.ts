// viewport-gizmo-material — overlay material contract.
//
// Gizmo materials are editor-owned runtime assets. Their pass metadata must
// use the same renderState shape as pack-authored MaterialAsset values so the
// renderer can place the gizmo after scene geometry and bypass depth testing.

import { describe, expect, it } from 'bun:test';
import type { EngineFacade } from '@forgeax/editor-core';

import { createGizmoPool } from '../viewport-gizmo';
import { createParamGizmo } from '../viewport-param-gizmo';

type MaterialPass = {
  queue?: unknown;
  renderState?: Record<string, unknown>;
};

type MaterialAsset = { passes?: MaterialPass[] };

describe('viewport gizmo material contract', () => {
  it('writes overlay queue and depth state under renderState', () => {
    const allocated: unknown[] = [];
    let nextEntity = 1;
    const editorEngine = {
      allocSharedRef(_kind: string, payload: unknown) {
        allocated.push(payload);
        return allocated.length as never;
      },
      spawn() {
        return { unwrap: () => nextEntity++ };
      },
      set() {},
      despawn() {},
    } as unknown as EngineFacade;

    const pool = createGizmoPool({
      editorEngine,
      getSelection: () => 29 as never,
      getGizmoMode: () => 'translate',
      getSelectionWorldTransform: () => ({
        x: 0, y: 0, z: 0,
        rotX: 0, rotY: 0, rotZ: 0,
        scaleX: 1, scaleY: 1, scaleZ: 1,
      }),
      getSelectionWorldQuat: () => [0, 0, 0, 1],
      getGizmoSpace: () => 'world',
      isAuxVisible: () => true,
      getDist: () => 10,
    });

    pool.update();

    const passes = allocated
      .map((asset) => (asset as MaterialAsset).passes?.[0])
      .filter((pass): pass is MaterialPass => pass !== undefined);
    expect(passes.length).toBeGreaterThan(0);
    expect(passes.every((pass) => pass.queue === undefined)).toBe(true);
    expect(passes.map((pass) => pass.renderState?.queue)).toContain(4000);
    expect(passes.map((pass) => pass.renderState?.queue)).toContain(4001);
    expect(passes.every((pass) => pass.renderState?.depthCompare === 'always')).toBe(true);
    expect(passes.every((pass) => pass.renderState?.depthWriteEnabled === false)).toBe(true);
  });

  it('uses the same front-most contract for camera parameter dots', () => {
    const allocated: unknown[] = [];
    let nextEntity = 1;
    const editorEngine = {
      allocSharedRef(_kind: string, payload: unknown) {
        allocated.push(payload);
        return allocated.length as never;
      },
      despawn() {},
      set() {},
    } as unknown as EngineFacade;

    const paramGizmo = createParamGizmo({
      editorEngine,
      spawnHandleCube: () => nextEntity++ as never,
      getSelection: () => 29 as never,
      getSelectionComponents: () => ({ Camera: { fov: 60, near: 0.1, far: 100 } }),
      getSelectionWorldTransform: () => ({
        x: 0, y: 0, z: 0,
        rotX: 0, rotY: 0, rotZ: 0,
        scaleX: 1, scaleY: 1, scaleZ: 1,
      }),
      isAuxVisible: () => true,
      getDist: () => 10,
      getAspect: () => 1,
    });

    paramGizmo.update();

    const pass = (allocated[0] as MaterialAsset).passes?.[0];
    expect(pass?.queue).toBeUndefined();
    expect(pass?.renderState).toMatchObject({
      queue: 4002,
      depthCompare: 'always',
      depthWriteEnabled: false,
    });
  });
});
