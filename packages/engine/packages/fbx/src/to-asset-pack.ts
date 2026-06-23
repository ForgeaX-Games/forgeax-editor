// to-asset-pack.ts — aggregate parsed sub-assets into ImportedAsset[] (t31).
//
// Each sub-asset POD is wrapped in an ImportedAsset envelope with a
// deterministic bridge GUID (hex-encoded sourceIndex). The import-runner
// overwrites the GUID with the meta.json UUID after this bridge returns.

import type {
  AnimationClipPod,
  ImportedAsset,
  MaterialAsset,
  MaterialPod,
  MeshAsset,
  MeshPod,
  SceneAsset,
  ScenePod,
  SkeletonPod,
  SkinPod,
  TexturePod,
} from '@forgeax/engine-types';

function bridgeGuid(kind: string, sourceIndex: number): string {
  const hex = sourceIndex.toString(16).padStart(12, '0');
  return `fbx-${kind}-${hex}`;
}

function buildMeshAsset(pod: MeshPod, guid: string): ImportedAsset {
  const vc = pod.vertices.length / 3;
  const FLOATS_PER_VERT = 12;
  const ib = new Float32Array(vc * FLOATS_PER_VERT);
  const n = pod.attributes.NORMAL as Float32Array | undefined;
  const u = pod.attributes.TEXCOORD_0 as Float32Array | undefined;

  for (let i = 0; i < vc; i++) {
    const d = i * FLOATS_PER_VERT;
    const p = i * 3;
    const t = i * 2;
    ib[d + 0] = pod.vertices[p + 0] ?? 0;
    ib[d + 1] = pod.vertices[p + 1] ?? 0;
    ib[d + 2] = pod.vertices[p + 2] ?? 0;
    ib[d + 3] = n?.[p + 0] ?? 0;
    ib[d + 4] = n?.[p + 1] ?? 0;
    ib[d + 5] = n?.[p + 2] ?? 0;
    ib[d + 6] = u?.[t + 0] ?? 0;
    ib[d + 7] = u?.[t + 1] ?? 0;
    ib[d + 8] = 1;
    ib[d + 9] = 0;
    ib[d + 10] = 0;
    ib[d + 11] = 1;
  }

  const mesh: MeshAsset = {
    kind: 'mesh',
    vertices: ib,
    ...(pod.indices ? { indices: pod.indices } : {}),
    attributes: {
      position: pod.vertices,
      normal: n ?? new Float32Array(vc * 3).fill(0),
      uv: u ?? new Float32Array(vc * 2).fill(0),
      tangent: new Float32Array(vc * 4).fill(0).map((_, i) => (i % 4 === 0 || i % 4 === 3 ? 1 : 0)),
    },
    submeshes: pod.submeshes.map((sm) => ({
      indexOffset: sm.indexOffset,
      indexCount: sm.indexCount,
      vertexCount: vc,
      topology: sm.topology,
    })),
  };

  return { guid, kind: 'mesh', payload: mesh, refs: [] };
}

function buildMaterialAsset(pod: MaterialPod, guid: string): ImportedAsset {
  const mat: MaterialAsset = {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        shader: 'forgeax::default-standard-pbr',
        tags: { LightMode: 'Forward' },
        queue: 2000,
      },
    ],
    paramValues: {
      baseColor: pod.baseColorFactor as readonly [number, number, number, number],
      metallic: pod.metallicFactor,
      roughness: pod.roughnessFactor,
    },
  };
  return { guid, kind: 'material', payload: mat, refs: [] };
}

function buildSceneAsset(pod: ScenePod, guid: string): ImportedAsset {
  const scene: SceneAsset = {
    kind: 'scene',
    entities: pod.entities.map((e) => ({
      localId: 0 as never, // M3: single-entity scene, no nesting
      components: {
        Transform: {
          posX: e.transform.translation[0],
          posY: e.transform.translation[1],
          posZ: e.transform.translation[2],
          quatX: e.transform.rotation[0],
          quatY: e.transform.rotation[1],
          quatZ: e.transform.rotation[2],
          quatW: e.transform.rotation[3],
          scaleX: e.transform.scale[0],
          scaleY: e.transform.scale[1],
          scaleZ: e.transform.scale[2],
        },
        ...(e.meshIndex !== null
          ? {
              MeshFilter: { mesh: null as unknown as never },
              MeshRenderer: { materials: [] as unknown as never },
            }
          : {}),
      },
    })),
  };
  return { guid, kind: 'scene', payload: scene, refs: [] };
}

// M3: TextureAsset requires decoded pixel data — deferred to M4.
// TexturePod.filePath is preserved for diagnostics during M3.
function buildTextureNote(_pod: TexturePod, _guid: string): ImportedAsset {
  // Produce a minimal placeholder; real texture import (decode + upload)
  // lands with M4 material parsing.
  return { guid: _guid, kind: 'texture', payload: {} as never, refs: [] };
}

export function toAssetPack(params: {
  readonly meshes: readonly MeshPod[];
  readonly scene: ScenePod;
  readonly materials: readonly MaterialPod[];
  readonly textures: readonly TexturePod[];
  readonly skeleton: SkeletonPod;
  readonly skin: SkinPod;
  readonly animationClips: readonly AnimationClipPod[];
}): readonly ImportedAsset[] {
  const assets: ImportedAsset[] = [];

  for (const mesh of params.meshes) {
    assets.push(buildMeshAsset(mesh, bridgeGuid('mesh', mesh.sourceIndex)));
  }

  for (const _mat of params.materials) {
    assets.push(buildMaterialAsset(_mat, bridgeGuid('material', assets.length)));
  }

  for (const tex of params.textures) {
    assets.push(buildTextureNote(tex, bridgeGuid('texture', tex.sourceIndex)));
  }

  // Skeleton asset (t48)
  if (params.skeleton.jointCount > 0) {
    assets.push({
      guid: bridgeGuid('skeleton', 0),
      kind: 'skeleton',
      payload: {
        kind: 'skeleton',
        joints: params.skeleton.jointPaths.map((_name, i) => ({
          jointIndex: i,
          name: _name,
          inverseBindMatrix: Array.from(
            params.skeleton.inverseBindMatrices.slice(i * 16, (i + 1) * 16),
          ),
        })),
      } as never,
      refs: [],
    });
  }

  // Skin asset (t49)
  if (params.skin.vertexCount > 0) {
    assets.push({
      guid: bridgeGuid('skin', 0),
      kind: 'skin',
      payload: {
        kind: 'skin',
        joints: params.skin.jointPaths.map((_name) => _name),
        influences: params.skin.influences.map((inf) => ({
          jointIndices: Array.from(inf.jointIndices),
          jointWeights: Array.from(inf.jointWeights),
        })),
      } as never,
      refs: [],
    });
  }

  // Animation clip assets (t50)
  for (let i = 0; i < params.animationClips.length; i++) {
    const clip = params.animationClips[i];
    if (!clip) continue;
    assets.push({
      guid: bridgeGuid('animation-clip', i),
      kind: 'animation-clip',
      payload: {
        kind: 'animation-clip',
        name: clip.name ?? `Clip${i}`,
        duration: clip.duration,
        channels: clip.channels.map((ch) => ({
          targetPath: ch.targetPath,
          property: ch.property,
          sampler: {
            input: Array.from(ch.sampler.input),
            output: Array.from(ch.sampler.output),
            interpolation: ch.sampler.interpolation,
          },
        })),
      } as never,
      refs: [],
    });
  }

  assets.push(buildSceneAsset(params.scene, bridgeGuid('scene', 0)));

  return assets;
}
