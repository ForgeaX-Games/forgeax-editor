// Unit tests for the Skeleton wireframe overlay (P1.3).
//
// The overlay is a frame-local read system: it walks the Scene subject's
// spawned subtree and draws a sphere at each joint's world translation plus
// a line to its parent joint. These tests pin the draw contract and the
// no-op conditions (no debugDraw, hidden, no root) using a mock World that
// records the BFS traversal + draw calls.

import { describe, expect, it, mock } from 'bun:test';
import { Children, Transform } from '@forgeax/engine-scene';
import { MeshFilter } from '@forgeax/engine-render';
import { installSkeletonOverlay } from '../skeleton-overlay';

interface Vec3 { readonly x: number; readonly y: number; readonly z: number }

interface MockEntity {
  readonly id: number;
  readonly translation: Vec3;
  readonly isMesh: boolean;
  readonly children: readonly MockEntity[];
}

interface MockWorld {
  readonly addSystem: ReturnType<typeof mock>;
  get: (entity: number, component: unknown) => { ok: boolean; value?: unknown; error?: string };
  drive: () => void;
}

function makeWorld(root: MockEntity | null): {
  readonly world: MockWorld;
  readonly debugDraw: { readonly sphere: ReturnType<typeof mock>; readonly line: ReturnType<typeof mock> };
  readonly spheres: { readonly center: unknown; readonly radius: number }[];
  readonly lines: { readonly from: unknown; readonly to: unknown }[];
} {
  const spheres: { readonly center: unknown; readonly radius: number }[] = [];
  const lines: { readonly from: unknown; readonly to: unknown }[] = [];
  const debugDraw = {
    sphere: mock((center: unknown, radius: number) => { spheres.push({ center, radius }); }),
    line: mock((from: unknown, to: unknown) => { lines.push({ from, to }); }),
  };

  const find = (node: MockEntity | null): MockEntity | null => {
    if (node === null) return null;
    if (node.id === (find as unknown as { readonly target: number }).target) return node;
    for (const child of node.children) {
      const hit = find(child);
      if (hit !== null) return hit;
    }
    return null;
  };

  const world: MockWorld = {
    addSystem: mock((_phase: unknown, def: { readonly fn: () => void }) => {
      (world as { drive: () => void }).drive = def.fn;
      return { ok: true, unwrap: () => undefined };
    }),
    drive: () => undefined,
    get: (entity: number, component: unknown) => {
      (find as unknown as { target: number }).target = entity;
      const node = find(root);
      if (node === null) return { ok: false, error: 'not-found' };
      if (component === Transform) {
        return { ok: true, value: { world: new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, node.translation.x, node.translation.y, node.translation.z, 1]) } };
      }
      if (component === MeshFilter) {
        return { ok: true, value: { assetHandle: node.isMesh ? 1 : 0 } };
      }
      if (component === Children) {
        return { ok: true, value: { entities: new Uint32Array(node.children.map((c) => c.id)) } };
      }
      return { ok: false, error: 'unknown-component' };
    },
  };
  return { world, debugDraw, spheres, lines };
}

describe('installSkeletonOverlay', () => {
  it('draws a sphere at each joint and a line to the parent joint', () => {
    // root(0,0,0) -> joint1(1,0,0) -> joint2(1,1,0)
    //              -> mesh(2,0,0)  (skipped)
    const joint2: MockEntity = { id: 3, translation: { x: 1, y: 1, z: 0 }, isMesh: false, children: [] };
    const mesh: MockEntity = { id: 4, translation: { x: 2, y: 0, z: 0 }, isMesh: true, children: [] };
    const joint1: MockEntity = { id: 2, translation: { x: 1, y: 0, z: 0 }, isMesh: false, children: [joint2] };
    const root: MockEntity = { id: 1, translation: { x: 0, y: 0, z: 0 }, isMesh: false, children: [joint1, mesh] };

    const { world, debugDraw, spheres, lines } = makeWorld(root);
    installSkeletonOverlay({
      world: world as never,
      debugDraw: debugDraw as never,
      getRoot: () => 1 as never,
      isVisible: () => true,
    });
    world.drive();

    // Three joints drawn (root + joint1 + joint2); mesh skipped.
    expect(spheres).toHaveLength(3);
    expect(Array.from(spheres[0]!.center as Float32Array)).toEqual([0, 0, 0]);
    expect(Array.from(spheres[1]!.center as Float32Array)).toEqual([1, 0, 0]);
    expect(Array.from(spheres[2]!.center as Float32Array)).toEqual([1, 1, 0]);
    // Two bone lines: root->joint1, joint1->joint2. No line to the mesh.
    expect(lines).toHaveLength(2);
    expect(Array.from(lines[0]!.from as Float32Array)).toEqual([0, 0, 0]);
    expect(Array.from(lines[0]!.to as Float32Array)).toEqual([1, 0, 0]);
    expect(Array.from(lines[1]!.from as Float32Array)).toEqual([1, 0, 0]);
    expect(Array.from(lines[1]!.to as Float32Array)).toEqual([1, 1, 0]);
  });

  it('is a no-op when the overlay is hidden', () => {
    const root: MockEntity = { id: 1, translation: { x: 0, y: 0, z: 0 }, isMesh: false, children: [] };
    const { world, debugDraw, spheres, lines } = makeWorld(root);
    installSkeletonOverlay({
      world: world as never,
      debugDraw: debugDraw as never,
      getRoot: () => 1 as never,
      isVisible: () => false,
    });
    world.drive();
    expect(spheres).toHaveLength(0);
    expect(lines).toHaveLength(0);
  });

  it('is a no-op when no Scene subject is loaded (root is null)', () => {
    const { world, debugDraw, spheres, lines } = makeWorld(null);
    installSkeletonOverlay({
      world: world as never,
      debugDraw: debugDraw as never,
      getRoot: () => null,
      isVisible: () => true,
    });
    world.drive();
    expect(spheres).toHaveLength(0);
    expect(lines).toHaveLength(0);
  });

  it('is a no-op when no debugDraw surface is provided', () => {
    const root: MockEntity = { id: 1, translation: { x: 0, y: 0, z: 0 }, isMesh: false, children: [] };
    const { world } = makeWorld(root);
    installSkeletonOverlay({
      world: world as never,
      debugDraw: undefined,
      getRoot: () => 1 as never,
      isVisible: () => true,
    });
    expect(() => world.drive()).not.toThrow();
  });

  it('registers a single Update system named editor-mesh-preview-skeleton-overlay', () => {
    const root: MockEntity = { id: 1, translation: { x: 0, y: 0, z: 0 }, isMesh: false, children: [] };
    const { world, debugDraw } = makeWorld(root);
    installSkeletonOverlay({
      world: world as never,
      debugDraw: debugDraw as never,
      getRoot: () => 1 as never,
      isVisible: () => true,
    });
    expect(world.addSystem).toHaveBeenCalledTimes(1);
  });
});
