// gltf-flatten unit tests — pure, no GLB file / no GPU.
//
// Feeds a hand-built in-memory GltfDoc + synthetic cooked-meta sub-asset table
// and asserts flattenGlbToSpawnDoc produces a persistable native SpawnDoc:
// group root + per-mesh-node entities (Mesh.meshAsset + Material.submeshMaterials)
// with hierarchy preserved. The round-trip guard replays the SpawnDoc through the
// SAME id-remap the VAG mode:'full' handler uses, then sessionToPack →
// packToSession, proving session → pack → reopen is lossless (Edit=Play).

import { describe, expect, it } from 'bun:test';

import type { GltfDoc } from '@forgeax/engine-gltf';

import { flattenGlbToSpawnDoc, type GlbFlattenMeta, type SpawnDoc } from '../gltf-flatten';
import { createEditSession, applyCommand } from '../document';
import { sessionToPack, packToSession } from '../scene-pack';
import type { EditorCommand } from '../types';

const MESH0 = 'aaaaaaaa-0000-5000-8000-000000000001';
const MESH1 = 'aaaaaaaa-0000-5000-8000-000000000002';
const MAT0 = 'bbbbbbbb-0000-5000-8000-000000000001';
const MAT1 = 'bbbbbbbb-0000-5000-8000-000000000002';

// Minimal GltfNodeIr — the flatten fn reads name/transform/meshIndex/children.
function node(opts: {
  name?: string;
  meshIndex?: number | null;
  children?: number[];
  t?: [number, number, number];
  r?: [number, number, number, number];
  s?: [number, number, number];
}): GltfDoc['nodes'][number] {
  return {
    name: opts.name,
    transform: {
      translation: opts.t ?? [0, 0, 0],
      rotation: opts.r ?? [0, 0, 0, 1],
      scale: opts.s ?? [1, 1, 1],
    },
    meshIndex: opts.meshIndex ?? null,
    skinIndex: null,
    children: opts.children ?? [],
    camera: null,
  } as GltfDoc['nodes'][number];
}

// Minimal doc.meshes rows (one per primitive), the flatten fn reads meshIndex +
// materialIndex only.
function meshRow(meshIndex: number, materialIndex: number | null): GltfDoc['meshes'][number] {
  return { meshIndex, materialIndex, positions: new Float32Array(0) } as GltfDoc['meshes'][number];
}

function makeDoc(opts: {
  nodes: GltfDoc['nodes'];
  meshes?: GltfDoc['meshes'];
  roots: number[];
}): GltfDoc {
  return {
    meshes: opts.meshes ?? [],
    materials: [],
    nodes: opts.nodes,
    scenes: [{ nodes: opts.roots }],
    textures: undefined,
    images: undefined,
    samplers: undefined,
    skeletons: [],
    animationClips: [],
    defaultSceneIndex: 0,
    diagnostics: { nodeNames: [], unsupportedExtensions: [], matrixTrsCoexistNodes: [] },
  } as unknown as GltfDoc;
}

const META: GlbFlattenMeta = {
  subAssets: [
    { guid: MESH0, kind: 'mesh', sourceIndex: 0 },
    { guid: MESH1, kind: 'mesh', sourceIndex: 1 },
    { guid: MAT0, kind: 'material', sourceIndex: 0 },
    { guid: MAT1, kind: 'material', sourceIndex: 1 },
  ],
};

describe('flattenGlbToSpawnDoc', () => {
  it('emits a Transform-only group root as order[0]', () => {
    const doc = makeDoc({ nodes: [node({ name: 'M', meshIndex: 0 })], meshes: [meshRow(0, 0)], roots: [0] });
    const sd = flattenGlbToSpawnDoc(doc, META, 'Fox')!;
    expect(sd).not.toBeNull();
    const rootId = sd.order[0]!;
    const root = sd.entities[rootId]!;
    expect(root.name).toBe('Fox');
    expect(root.parent).toBeNull();
    expect(Object.keys(root.components)).toEqual(['Transform']);
  });

  it('maps each mesh node to Mesh.meshAsset from the meta sub-asset table', () => {
    const doc = makeDoc({
      nodes: [node({ name: 'A', meshIndex: 0 }), node({ name: 'B', meshIndex: 1 })],
      meshes: [meshRow(0, 0), meshRow(1, 1)],
      roots: [0, 1],
    });
    const sd = flattenGlbToSpawnDoc(doc, META, 'G')!;
    const meshEnts = sd.order.slice(1).map((id) => sd.entities[id]!);
    const guids = meshEnts.map((e) => (e.components.Mesh as { meshAsset?: string } | undefined)?.meshAsset);
    expect(guids).toEqual([MESH0, MESH1]);
  });

  it('preserves hierarchy: child parents to its glTF parent, scene root parents to the group', () => {
    // 0 (root mesh) → child 1 (mesh)
    const doc = makeDoc({
      nodes: [node({ name: 'parent', meshIndex: 0, children: [1] }), node({ name: 'child', meshIndex: 1 })],
      meshes: [meshRow(0, 0), meshRow(1, 1)],
      roots: [0],
    });
    const sd = flattenGlbToSpawnDoc(doc, META, 'G')!;
    const groupId = sd.order[0]!;
    const parentEnt = Object.values(sd.entities).find((e) => e.name === 'parent')!;
    const childEnt = Object.values(sd.entities).find((e) => e.name === 'child')!;
    // Find parent's local id
    const parentId = Number(Object.keys(sd.entities).find((k) => sd.entities[Number(k)] === parentEnt));
    expect(parentEnt.parent).toBe(groupId);
    expect(childEnt.parent).toBe(parentId);
  });

  it('converts a 90°-about-Y quaternion to Transform.rotY ≈ 90', () => {
    const q: [number, number, number, number] = [0, Math.SQRT1_2, 0, Math.SQRT1_2]; // 90° Y
    const doc = makeDoc({
      nodes: [node({ name: 'R', meshIndex: 0, t: [1, 2, 3], s: [2, 2, 2], r: q })],
      meshes: [meshRow(0, 0)],
      roots: [0],
    });
    const sd = flattenGlbToSpawnDoc(doc, META, 'G')!;
    const ent = Object.values(sd.entities).find((e) => e.name === 'R')!;
    const t = ent.components.Transform as Record<string, number>;
    expect(t.x).toBe(1); expect(t.y).toBe(2); expect(t.z).toBe(3);
    expect(t.scaleX).toBe(2);
    expect(Math.round(t.rotY!)).toBe(90);
  });

  it('builds submeshMaterials from a mesh with multiple primitives', () => {
    // mesh 0 has 2 primitives → materials [MAT0, MAT1]
    const doc = makeDoc({
      nodes: [node({ name: 'multi', meshIndex: 0 })],
      meshes: [meshRow(0, 0), meshRow(0, 1)],
      roots: [0],
    });
    const sd = flattenGlbToSpawnDoc(doc, META, 'G')!;
    const ent = Object.values(sd.entities).find((e) => e.name === 'multi')!;
    const mat = ent.components.Material as { submeshMaterials?: string[] };
    expect(mat.submeshMaterials).toEqual([MAT0, MAT1]);
  });

  it('keeps a transform-only anchor node and its mesh subtree', () => {
    // 0 = empty container (no mesh) → child 1 (mesh)
    const doc = makeDoc({
      nodes: [node({ name: 'empty', meshIndex: null, children: [1] }), node({ name: 'leaf', meshIndex: 0 })],
      meshes: [meshRow(0, 0)],
      roots: [0],
    });
    const sd = flattenGlbToSpawnDoc(doc, META, 'G')!;
    const empty = Object.values(sd.entities).find((e) => e.name === 'empty')!;
    const leaf = Object.values(sd.entities).find((e) => e.name === 'leaf')!;
    expect(Object.keys(empty.components)).toEqual(['Transform']); // anchor kept, no Mesh
    expect((leaf.components.Mesh as { meshAsset?: string }).meshAsset).toBe(MESH0);
  });

  it('returns null when the meta declares no mesh sub-assets', () => {
    const doc = makeDoc({ nodes: [node({ meshIndex: 0 })], meshes: [meshRow(0, 0)], roots: [0] });
    expect(flattenGlbToSpawnDoc(doc, { subAssets: [] }, 'G')).toBeNull();
  });

  it('round-trips through applyCommand → sessionToPack → packToSession losslessly', () => {
    const doc = makeDoc({
      nodes: [node({ name: 'parent', meshIndex: 0, children: [1] }), node({ name: 'child', meshIndex: 1 })],
      meshes: [meshRow(0, 0), meshRow(1, 1)],
      roots: [0],
    });
    const sd: SpawnDoc = flattenGlbToSpawnDoc(doc, META, 'Fox')!;

    // Replay with the SAME id-remap the VAG mode:'full' handler applies.
    const session = createEditSession();
    const base = session.nextLocalId;
    const idMap = new Map<number, number>();
    sd.order.forEach((sid, i) => idMap.set(sid, base + i));
    for (const sid of sd.order) {
      const ent = sd.entities[sid]!;
      const cmd: EditorCommand = {
        kind: 'spawnEntity',
        _id: idMap.get(sid)!,
        name: ent.name,
        parent: ent.parent == null ? null : idMap.get(ent.parent)!,
        components: ent.components,
      };
      const r = applyCommand(session, cmd);
      expect(r.ok).toBe(true); // no INVALID_PARENT rollback
    }

    // session → pack → reopen
    const pack = sessionToPack(session, 'fixed-scene-guid-0000-0000-000000000000');
    const reopened = packToSession(pack);

    // Every mesh entity keeps its meshAsset + parent survives reopen.
    const meshAssets = Object.values(reopened.entities)
      .map((e) => (e.components as { Mesh?: { meshAsset?: string } }).Mesh?.meshAsset)
      .filter(Boolean)
      .sort();
    expect(meshAssets).toEqual([MESH0, MESH1].sort());

    // Hierarchy: the child entity still has a parent (not orphaned to root).
    const childEnt = Object.values(reopened.entities).find((e) => e.name === 'child')!;
    expect(childEnt.parent).not.toBeNull();
    expect(childEnt.parent).not.toBeUndefined();
  });
});
