// viewport-gizmo-overlay — Editor Gizmo post-scene overlay contract.
//
// The Gizmo must be emitted through DebugDraw rather than editorWorld
// MeshRenderers. DebugDraw is flushed by the engine's real debug-overlay pass,
// after scene composition, with depthCompare='always'.

import { describe, expect, it } from 'bun:test';
import { srgbChannelToLinear } from '@forgeax/engine-types';

import { createGizmoPool, type GizmoOverlayDraw } from '../viewport-gizmo';
import { createParamGizmo } from '../viewport-param-gizmo';

type LineCall = { from: ArrayLike<number>; to: ArrayLike<number>; color: unknown };
type ArrowCall = { from: ArrayLike<number>; to: ArrayLike<number>; color: unknown; tipLength?: number };

function makeDebugDraw(): {
  draw: GizmoOverlayDraw;
  lines: LineCall[];
  arrows: ArrowCall[];
} {
  const lines: LineCall[] = [];
  const arrows: ArrowCall[] = [];
  return {
    lines,
    arrows,
    draw: {
      line(from, to, color) { lines.push({ from, to, color }); },
      arrow(from, to, color, tipLength) { arrows.push({ from, to, color, tipLength }); },
    },
  };
}

describe('viewport gizmo post-scene overlay contract', () => {
  it('emits transform handles through DebugDraw without creating editor entities', () => {
    const { draw, lines, arrows } = makeDebugDraw();
    const pool = createGizmoPool({
      getAnchor: () => ({ center: [0, 0, 0], quat: [0, 0, 0, 1] }),
      getGizmoMode: () => 'translate',
      getGizmoSpace: () => 'world',
      isAuxVisible: () => true,
      getViewScale: () => 10,
    });

    pool.update();
    pool.drawOverlay(draw);

    expect(arrows).toHaveLength(3);
    expect(lines).toHaveLength(12);
  });

  it('keeps transform handles as filled triangle geometry for the render feature', () => {
    const pool = createGizmoPool({
      getAnchor: () => ({ center: [0, 0, 0], quat: [0, 0, 0, 1] }),
      getGizmoMode: () => 'translate',
      getGizmoSpace: () => 'world',
      isAuxVisible: () => true,
      getViewScale: () => 10,
    });

    pool.update();
    const vertices = pool.getOverlayVertices();

    // 3 solid axis bars + 3 closed cones + 3 solid plane handles.
    expect(vertices.length).toBe(14 * 36);
    expect(vertices.every((vertex) => vertex.color[3] === 1)).toBe(true);
    expect(vertices.some((vertex) => vertex.position[0] > 1.3)).toBe(true);

    // The former Materials.unlit path decoded authored sRGB tints before
    // writing the linear HDR scene target. The overlay feature must preserve
    // that exact color-domain contract.
    const red = vertices.find((vertex) => (
      vertex.color[0] === srgbChannelToLinear(1)
      && vertex.color[1] === srgbChannelToLinear(0.25)
      && vertex.color[2] === srgbChannelToLinear(0.2)
    ));
    expect(red).toBeDefined();
  });

  it('renders camera parameter chrome in the same post-scene line stream', () => {
    const { draw, lines } = makeDebugDraw();
    const paramGizmo = createParamGizmo({
      getSelection: () => 29 as never,
      getSelectionComponents: () => ({
        Camera: { fov: Math.PI / 3, near: 0.1, far: 100 },
      }),
      getSelectionWorldTransform: () => ({
        x: 0, y: 0, z: 0,
        rotX: 0, rotY: 0, rotZ: 0,
        scaleX: 1, scaleY: 1, scaleZ: 1,
      }),
      isAuxVisible: () => true,
      getViewScale: () => 10,
      getAspect: () => 1,
    });

    paramGizmo.update();
    paramGizmo.drawOverlay(draw);

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.color).valueOf()).toBe(true);
    expect(paramGizmo.getOverlayVertices().length).toBeGreaterThan(0);
  });
});
