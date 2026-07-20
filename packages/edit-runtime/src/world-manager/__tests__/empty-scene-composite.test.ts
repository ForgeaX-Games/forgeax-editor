// empty-scene-composite.test.ts (w17) — E3 空 scene 组合渲染不黑屏（test-first RED，impl w18/w21）。
//
// feat-20260709-editor-world-partition-editorworld-super-composite / M4.
//
// E3（requirements）：空 scene 组合渲染不崩——editorWorld（含相机，无 gizmo）+
// sceneWorld（无几何、无 skybox/skylight）经 world-manager 的 drawSource 组合渲染，
// draw 调用不崩、返回 ok（resource-owner 无资源时走 engine 声明缺省行为，非 crash /
// 非黑屏死循环）。
//
// 这里用 createApp assemble 形态 + fake renderer 记录 draw 调用（同 w9
// editworld-freeze-snapshot 的 headless rig：bun 无 GPU，fake renderer 的 draw
// 返回 { ok: true }），把 world-manager 的 createDrawSource() 喂进 createApp 的
// drawSource 缝。断言：
//   • 帧循环 tick 一次后 renderer.draw 被调用（组合路径真的驱动了 draw）；
//   • draw 收到的 worlds 是 [editorWorld, sceneWorld] 两个 world（cameraOwner=0
//     editorWorld、resourceOwner=1 sceneWorld）；
//   • draw 返回 ok（非 error、非 throw）——即使 sceneWorld 无任何资源。
//
// bun 无 requestAnimationFrame；capturing fake rAF 手动步帧（同 w9）。
//
// Anchors:
//   requirements E3（空 scene 组合渲染不崩，不得黑屏死循环）
//   plan-strategy §5.3 关键测试点「E3 空 scene 组合渲染不黑屏」
//   plan-strategy §2 D-3（drawSource → update injected worlds → draw）

import { describe, expect, it } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { createApp } from '@forgeax/engine-app';
import { transformPlugin, timePlugin, Camera, Transform, perspective } from '@forgeax/engine-runtime';
import { WorldManager } from '../index';

function installFakeRaf() {
  const g = globalThis as unknown as {
    requestAnimationFrame?: (cb: (t: number) => void) => number;
    cancelAnimationFrame?: (id: number) => void;
  };
  const prevRaf = g.requestAnimationFrame;
  const prevCaf = g.cancelAnimationFrame;
  let captured: ((t: number) => void) | null = null;
  g.requestAnimationFrame = (cb: (t: number) => void) => {
    captured = cb;
    return 1;
  };
  g.cancelAnimationFrame = () => {
    captured = null;
  };
  return {
    step(t = 16): void {
      const cb = captured;
      captured = null;
      cb?.(t);
    },
    restore(): void {
      g.requestAnimationFrame = prevRaf;
      g.cancelAnimationFrame = prevCaf;
    },
  };
}

interface DrawCall {
  worlds: readonly World[];
  cameraOwner: number;
  resourceOwner: number;
}

function makeFakeRenderer(record: DrawCall[]) {
  return {
    ready: Promise.resolve({ ok: true }),
    assets: { instantiate: () => ({ ok: true as const, value: 1 }) },
    draw(worlds: World[] | World, opts?: { cameraOwner?: number; resourceOwner?: number; owner?: number }) {
      // Record only the multi-world (composite) form. The single-world legacy
      // form (draw(world)) is not what the composite path emits.
      if (Array.isArray(worlds)) {
        record.push({
          worlds,
          cameraOwner: opts?.cameraOwner ?? 0,
          resourceOwner: opts?.resourceOwner ?? 0,
        });
      }
      return { ok: true } as const;
    },
    dispose() {},
    onError(_cb: (e: unknown) => void) {
      return () => {};
    },
  };
}

describe('w17 — E3 empty scene composite render does not crash', () => {
  it('drawSource feeds [editorWorld, sceneWorld]; draw returns ok even with an empty scene', async () => {
    const fakeRaf = installFakeRaf();
    try {
      // sceneWorld: empty (no geometry, no skybox/skylight) — the E3 case.
      const sceneWorld = new World();
      transformPlugin().build(sceneWorld);

      const wm = new WorldManager(() => sceneWorld);
      // editorWorld carries a camera (no gizmo) so the composite has a valid
      // cameraOwner view; resourceOwner (sceneWorld) is intentionally resource-less.
      wm.editorFacade
        .spawn(
          { component: Transform, data: { pos: [0, 1.5, 9] } },
          { component: Camera, data: { ...perspective({ fov: Math.PI / 3, aspect: 1 }) } },
        )
        .unwrap();

      const drawCalls: DrawCall[] = [];
      const editorApp = await createApp({
        renderer: makeFakeRenderer(drawCalls) as never,
        world: wm.editorWorld as never,
        plugins: [transformPlugin(), timePlugin()],
        drawSource: wm.createDrawSource(),
      } as never);
      if (!editorApp.ok) throw new Error('editorApp assemble failed');
      const app = editorApp.value;

      const startRes = app.start();
      expect(startRes.ok).toBe(true);
      fakeRaf.step();

      // The composite path drove at least one multi-world draw.
      expect(drawCalls.length).toBeGreaterThanOrEqual(1);
      const last = drawCalls[drawCalls.length - 1]!;
      // Two worlds fed, editor camera owner + scene resource owner.
      expect(last.worlds.length).toBe(2);
      expect(last.worlds[0]).toBe(wm.editorWorld);
      expect(last.worlds[1]).toBe(sceneWorld);
      expect(last.cameraOwner).toBe(0);
      expect(last.resourceOwner).toBe(1);

      app.stop();
    } finally {
      fakeRaf.restore();
    }
  });
});
