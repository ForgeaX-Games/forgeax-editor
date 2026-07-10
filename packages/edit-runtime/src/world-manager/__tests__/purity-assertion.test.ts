// purity-assertion.test.ts (w16) — AC-01 双向纯净性断言（test-first RED，impl w18）。
//
// feat-20260709-editor-world-partition-editorworld-super-composite / M4.
//
// AC-01 的结构性保证：分家后编辑相机与 gizmo 实体存在于 editorWorld、**不**存在于
// sceneWorld；save 产出的 scene-pack 因此零编辑器实体。这条不变量的机制根源是
// world-manager 持有的专用 EngineFacade 只写 editorWorld（plan-strategy §2 D-5），
// 所以「编辑器实体绝不落入 sceneWorld」是结构性成立、而非分家前那种 save 时隐式剔除。
//
// 本单测直接构造分家后的两 world 拓扑：
//   • editorWorld = WorldManager 装配（new World() + transformPlugin），经其
//     editorFacade spawn 编辑相机 + gizmo(Overlay MeshRenderer)；
//   • sceneWorld = new World() + transformPlugin，spawn 至少 1 个 authored 实体
//     （带 Name 的场景几何）——防空转：若 sceneWorld 为空，「无编辑器实体」断言永真。
//
// 断言（双向，非空转）：
//   (AC-01 ①) editorWorld 含 camera entity（Camera 组件）+ gizmo entity（无 Name 的
//             MeshRenderer——gizmo 是非 authored 的编辑器叠加实体）。
//   (AC-01 ②) sceneWorld 零编辑器实体：无任何实体带 Camera（编辑相机）；无任何无-Name
//             的 MeshRenderer（gizmo 形态）。
//   (anti-vacuous) sceneWorld 至少含 1 个 authored 实体（带 Name）。
//
// Anchors:
//   requirements AC-01（editorWorld 独立且 save 纯净；纯净性断言非空转）
//   plan-strategy §5.3 关键测试点「AC-01 双向断言（防空转）」
//   research F3（AC-01 现状靠隐式排除，分家后应结构性不存在）

import { describe, expect, it } from 'bun:test';
import {
  Camera,
  MeshFilter,
  MeshRenderer,
  Materials,
  Name,
  Transform,
  transformPlugin,
  perspective,
} from '@forgeax/engine-runtime';
// engine #650 (Tier-2 decomposition) moved builtin handles into
// @forgeax/engine-assets-runtime.
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World, Entity, type EntityHandle } from '@forgeax/engine-ecs';
import { WorldManager } from '../index';

// NOTE: entComponents (editor helper) treats a Name-less entity as stale (Name is
// its liveness probe) and returns {} — the editor camera + gizmo carry NO Name, so
// entComponents cannot introspect them. Probe components directly via world.get.
const has = (world: World, h: EntityHandle, token: unknown): boolean =>
  world.get(h, token as Parameters<World['get']>[1]).ok;

/** Enumerate EVERY live entity handle in a world via the archetype-graph self
 *  column (same idiom as editworld-freeze-snapshot.test.ts). Unlike
 *  worldEntityHandles (a Name-query walk), this surfaces Name-less entities too —
 *  the editor camera + gizmo carry no Name, so a Name walk would miss them. */
function allEntityHandles(world: World): EntityHandle[] {
  const out: EntityHandle[] = [];
  const graph = (
    world as unknown as {
      _getGraph: () => {
        archetypes: { columns: Map<number, Map<string, { view: Uint32Array }>>; size: number }[];
      };
    }
  )._getGraph();
  for (const arch of graph.archetypes) {
    const selfCol = arch.columns.get(Entity.id)?.get('self');
    if (!selfCol) continue;
    for (let row = 0; row < arch.size; row++) {
      out.push(selfCol.view[row]! as unknown as EntityHandle);
    }
  }
  return out;
}

/** Build a sceneWorld with propagateTransforms + one authored (Named) entity so
 *  the "sceneWorld has zero editor entities" assertion is non-vacuous. */
function makeSceneWorld(): World {
  const scene = new World();
  transformPlugin().build(scene);
  scene.spawn(
    { component: Name, data: { value: 'AuthoredCube' } },
    { component: Transform, data: { pos: [0, 0, 0] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: {} },
  );
  return scene;
}

describe('w16 — AC-01 editorWorld / sceneWorld purity (bidirectional, non-vacuous)', () => {
  it('editorWorld carries the editor camera + gizmo; sceneWorld carries neither', () => {
    const sceneWorld = makeSceneWorld();
    const wm = new WorldManager(() => sceneWorld);
    const editorWorld = wm.editorWorld;

    // Spawn the editor camera + a gizmo overlay entity through world-manager's
    // dedicated facade — the ONLY write path onto editorWorld (D-5). This mirrors
    // what w19 (camera) + w20 (gizmo) do at runtime.
    const aspect = 1;
    wm.editorFacade
      .spawn(
        { component: Transform, data: { pos: [0, 1.5, 9] } },
        { component: Camera, data: { ...perspective({ fov: Math.PI / 3, aspect }) } },
      )
      .unwrap();
    const overlayMat = wm.editorFacade.allocSharedRef(
      'MaterialAsset',
      Materials.unlit([1, 0.25, 0.2, 1]),
    );
    wm.editorFacade
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { materials: [overlayMat] } },
      )
      .unwrap();

    // ── AC-01 ① editorWorld has a camera entity + a gizmo entity ───────────────
    const editorHandles = allEntityHandles(editorWorld);
    const hasCamera = (world: World, handles: EntityHandle[]): boolean =>
      handles.some((h) => has(world, h, Camera));
    // gizmo = a MeshRenderer entity with NO Name (non-authored editor overlay).
    const hasGizmo = (world: World, handles: EntityHandle[]): boolean =>
      handles.some((h) => has(world, h, MeshRenderer) && !has(world, h, Name));

    expect(hasCamera(editorWorld, editorHandles)).toBe(true);
    expect(hasGizmo(editorWorld, editorHandles)).toBe(true);

    // ── AC-01 ② sceneWorld has zero editor entities (no camera, no gizmo) ──────
    const sceneHandles = allEntityHandles(sceneWorld);
    expect(hasCamera(sceneWorld, sceneHandles)).toBe(false);
    expect(hasGizmo(sceneWorld, sceneHandles)).toBe(false);

    // ── anti-vacuous: sceneWorld actually has an authored entity ───────────────
    const authored = sceneHandles.filter((h) => has(sceneWorld, h, Name));
    expect(authored.length).toBeGreaterThanOrEqual(1);
  });
});
