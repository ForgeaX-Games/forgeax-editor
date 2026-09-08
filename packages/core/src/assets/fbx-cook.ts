// fbx-cook.ts — frontend FBX → meta.json cook via ufbx WASM.
//
// Browser-side equivalent of gltf-cook.ts but for FBX files. Uses the ufbx WASM
// parser + parse-*.ts pipeline — both now live in @forgeax/engine-fbx after the
// engine collapsed the separate -wasm package into it (feat-20260704-collapse-
// fbx-to-ufbx) — to produce a canonical `external-asset-package` sidecar with
// sub-asset declarations and reimport-stable GUIDs.
//
// Architecture: FBX bytes → ufbx WASM → JSON POD → parse-*.ts → meta.json
// This matches the native binding.cc → JSON POD → parse-*.ts path, but
// runs entirely in the browser (no Node.js, no Autodesk FBX SDK).

import { AssetGuid } from '@forgeax/engine-pack/guid';
import { serializeMetaJson } from '@forgeax/engine-gltf';
import {
  initFbxWasm,
  parseFbx,
  isFbxWasmReady,
  parseMesh,
  parseScene,
  parseMaterial,
  parseSkeleton,
  parseSkin,
  parseAnimationClips,
  parseTextures,
  type FbxRawDocument,
  type FbxRawMesh,
  type FbxRawNodes,
  type FbxRawMaterial,
  type FbxRawSkeletonDoc,
  type FbxRawSkinDoc,
  type FbxRawAnimDoc,
  deriveFbxSourceKeys,
  resolveFbxTexturePath,
  type FbxTexturePathRequest,
} from '@forgeax/engine-fbx';
import {
  MESH_MATERIAL_SLOT_SOURCE_OVERRIDE_PAYLOAD_SCHEMA,
  type TexturePod,
  type MeshMaterialSlotTopologyEntry,
  reconcileMeshMaterialSlotTopology,
} from '@forgeax/engine-types';

export interface FbxCookResult {
  readonly ok: boolean;
  readonly metaJson?: string;
  readonly summary?: { readonly byKind: Record<string, number>; readonly total: number };
  readonly code?: 'FBX_PARSE_FAILED' | 'FBX_SOURCE_INVALID';
  readonly error?: string;
}

/** Preserve the user-authorized FBX dependency scope when a reimport omits options. */
export function mergeFbxImportSettings(
  existingMeta: unknown,
  fbxCandidatePaths?: readonly string[],
): Readonly<Record<string, unknown>> {
  const existingSettings = existingMeta && typeof existingMeta === 'object'
    ? (existingMeta as { readonly importSettings?: unknown }).importSettings
    : undefined;
  const preservedSettings = existingSettings !== null
    && typeof existingSettings === 'object'
    && !Array.isArray(existingSettings)
    ? existingSettings as Readonly<Record<string, unknown>>
    : {};
  return {
    ...preservedSettings,
    ...(fbxCandidatePaths === undefined ? {} : { fbxCandidatePaths: [...fbxCandidatePaths] }),
  };
}

export interface FbxDependencyCandidate {
  /** Path as selected by the user, relative to the selected folder root. */
  readonly relativePath: string;
  /** Same file addressed relative to the FBX source directory. */
  readonly sourceRelativePath: string;
}

export type FbxDependencyResolution =
  | { readonly ok: true; readonly files: readonly FbxDependencyCandidate[] }
  | {
      readonly ok: false;
      readonly code:
        | 'fbx-external-texture-missing'
        | 'fbx-external-texture-ambiguous'
        | 'fbx-external-texture-unsupported'
        | 'fbx-source-invalid';
      readonly hint: string;
    };

function fbxTextureRequests(
  doc: FbxRawDocument & FbxRawSkeletonDoc & FbxRawSkinDoc & FbxRawAnimDoc,
): readonly { readonly sourceIndex: number; readonly request: FbxTexturePathRequest; readonly embedded: boolean; readonly type?: string }[] {
  const textures = parseTextures({
    textures: (doc as unknown as { textures?: readonly unknown[] }).textures as never,
  });
  const materialDocs =
    (doc as unknown as { materials?: readonly FbxRawMaterial[] }).materials ?? [];
  const materials = materialDocs.map((raw, i) => parseMaterial(raw, i));
  const used = new Set(
    materials.flatMap((material) =>
      (material.textureBindings ?? []).map(
        (binding: { readonly textureIndex: number }) => binding.textureIndex,
      ),
    ),
  );
  return textures
    .filter((texture: TexturePod) => used.has(texture.sourceIndex))
    .map((texture: TexturePod) => ({
      sourceIndex: texture.sourceIndex,
      request: {
        ...(texture.relativeFilePath === undefined ? {} : { declaredRelativePath: texture.relativeFilePath }),
        ...(texture.filePath.length === 0 ? {} : { declaredFilename: texture.filePath }),
        ...(texture.absoluteFilePath === undefined ? {} : { declaredAbsolutePath: texture.absoluteFilePath }),
      },
      embedded: texture.embeddedBytes !== undefined && texture.embeddedBytes.byteLength > 0,
      ...(texture.type === undefined ? {} : { type: texture.type }),
    }));
}

/** Resolve the exact external texture closure before the Editor writes anything. */
export async function resolveFbxImportDependencies(
  bytes: ArrayBuffer,
  sourceRelativePath: string,
  candidates: readonly FbxDependencyCandidate[],
): Promise<FbxDependencyResolution> {
  try {
    if (!isFbxWasmReady()) await initFbxWasm();
    const doc = JSON.parse(parseFbx(new Uint8Array(bytes))) as FbxRawDocument &
      FbxRawSkeletonDoc & FbxRawSkinDoc & FbxRawAnimDoc;
    const requests = fbxTextureRequests(doc);
    const selected = new Map<string, FbxDependencyCandidate>();
    for (const dependency of requests) {
      if (dependency.embedded) continue;
      if (dependency.type !== undefined && dependency.type !== 'file') {
        return {
          ok: false,
          code: 'fbx-external-texture-unsupported',
          hint: `FBX texture ${dependency.sourceIndex} is ${dependency.type}; flatten it to a file texture before importing.`,
        };
      }
      const resolution = resolveFbxTexturePath(
        sourceRelativePath,
        dependency.request,
        candidates.map(({ sourceRelativePath: relativePath }) => ({ relativePath })),
      );
      if (!resolution.ok) {
        return {
          ok: false,
          code: resolution.code,
          hint: `${resolution.code} for texture ${dependency.sourceIndex}; requested ${resolution.requestedPath || '<unnamed>'}.`,
        };
      }
      const match = candidates.find((candidate) =>
        candidate.sourceRelativePath.replaceAll('\\', '/').toLowerCase() === resolution.relativePath.toLowerCase(),
      );
      if (match === undefined) {
        return {
          ok: false,
          code: 'fbx-external-texture-missing',
          hint: `Resolved FBX texture path ${resolution.relativePath} is outside the selected dependency scope.`,
        };
      }
      selected.set(match.relativePath.replaceAll('\\', '/'), match);
    }
    return { ok: true, files: [...selected.values()] };
  } catch (error) {
    return {
      ok: false,
      code: 'fbx-source-invalid',
      hint: error instanceof Error ? error.message : String(error),
    };
  }
}

// Mint a fresh asset GUID via the engine's authoritative generator
// (UUIDv7, dash-form string). AGENTS.md #1 / architecture-principles §2:
// never hand-roll a second GUID generator — the engine owns this.
function generateGuid(): string {
  return AssetGuid.format(AssetGuid.random());
}

type FbxSubAssetIdentity = {
  readonly kind: string;
  readonly sourceIndex: number;
  readonly guid: string;
  readonly sourceKey?: string;
  readonly name?: string;
};

/** Apply semantic FBX identity without ever aliasing an inserted output. */
export function reuseFbxSubAssetGuids(
  current: readonly FbxSubAssetIdentity[],
  existing: readonly FbxSubAssetIdentity[] = [],
): FbxSubAssetIdentity[] {
  const existingUsesSourceKeys = existing.some(
    (entry) => typeof entry.sourceKey === 'string' && entry.sourceKey.length > 0,
  );
  const existingBySourceKey = new Map(
    existing.flatMap((entry) => entry.sourceKey === undefined ? [] : [[entry.sourceKey, entry.guid]]),
  );
  const existingByPosition = new Map(
    existing.map((entry) => [`${entry.kind}:${entry.sourceIndex}`, entry.guid]),
  );
  return current.map((entry) => ({
    ...entry,
    guid:
      (entry.sourceKey === undefined ? undefined : existingBySourceKey.get(entry.sourceKey))
      ?? (!existingUsesSourceKeys
        ? existingByPosition.get(`${entry.kind}:${entry.sourceIndex}`)
        : undefined)
      ?? entry.guid,
  }));
}

function textureSourceKey(texture: { readonly filePath: string; readonly name?: string }): string {
  const normalized = texture.filePath.replaceAll('\\', '/');
  const withoutDrive = normalized.replace(/^[A-Za-z]:\//, '').replace(/^\/+/, '');
  const segments = withoutDrive.split('/').filter(Boolean);
  const texturesSegment = segments.findIndex((segment) => segment.toLowerCase() === 'textures');
  const semanticPath =
    texturesSegment >= 0 ? segments.slice(texturesSegment).join('/') : segments.at(-1) ?? texture.name ?? 'unnamed';
  return `fbx:texture:${semanticPath.toLowerCase()}`;
}

/**
 * Cook an .fbx source's raw bytes into a canonical meta.json string.
 *
 * @param bytes        raw FBX file bytes
 * @param sourceName   basename, e.g. "character.fbx"
 * @param existingMeta parsed existing meta.json for GUID reuse on reimport
 */
export async function cookFbxMeta(
  bytes: ArrayBuffer,
  sourceName: string,
  existingMeta?: unknown,
  options: { readonly fbxCandidatePaths?: readonly string[] } = {},
): Promise<FbxCookResult> {
  try {
    if (!isFbxWasmReady()) await initFbxWasm();

    const jsonStr = parseFbx(new Uint8Array(bytes));
    const doc = JSON.parse(jsonStr) as FbxRawDocument &
      FbxRawSkeletonDoc &
      FbxRawSkinDoc &
      FbxRawAnimDoc;

    // Check for error envelope
    const maybeError = doc as unknown as {
      error?: { code: string; message: string };
    };
    if (maybeError.error) {
      return { ok: false, code: 'FBX_PARSE_FAILED', error: `fbx-parse: ${maybeError.error.message}` };
    }

    // Parse all sub-assets to discover what the FBX contains
    const rawMeshes: readonly FbxRawMesh[] = doc.meshes ?? [];
    const meshes = rawMeshes.map((raw, i) => parseMesh(raw, i));
    parseScene(doc as unknown as FbxRawNodes);
    const materialDocs =
      (doc as unknown as { materials?: readonly FbxRawMaterial[] }).materials ?? [];
    const materials =
      materialDocs.length > 0
        ? materialDocs.map((raw, i) => parseMaterial(raw, i))
        : [parseMaterial({ kind: 'fallback' }, 0)];
    const skeleton = parseSkeleton(doc);
    const skin = parseSkin(doc);
    const animationClips = parseAnimationClips(doc);
    const textures = parseTextures({
      textures: (doc as unknown as { textures?: readonly unknown[] }).textures as never,
    });

    // Build sub-asset declarations
    const subAssets: {
      kind: string;
      sourceIndex: number;
      guid: string;
      name?: string;
      sourceKey?: string;
    }[] = [];

    for (const mesh of meshes) {
      subAssets.push({
        kind: 'mesh',
        sourceIndex: mesh.sourceIndex,
        guid: generateGuid(),
        ...(mesh.name ? { name: mesh.name } : {}),
      });
    }

    for (let i = 0; i < materials.length; i++) {
      subAssets.push({
        kind: 'material',
        sourceIndex: i,
        guid: generateGuid(),
        ...(materials[i]?.name ? { name: materials[i]!.name } : {}),
      });
    }

    if (skeleton.jointCount > 0) {
      subAssets.push({
        kind: 'skeleton',
        sourceIndex: 0,
        guid: generateGuid(),
      });
    }

    if (skin.vertexCount > 0) {
      subAssets.push({
        kind: 'skin',
        sourceIndex: 0,
        guid: generateGuid(),
      });
    }

    for (let i = 0; i < animationClips.length; i++) {
      subAssets.push({
        kind: 'animation-clip',
        sourceIndex: i,
        guid: generateGuid(),
        ...(animationClips[i]?.name ? { name: animationClips[i]!.name } : {}),
      });
    }

    const usedTextureIndices = new Set(
      materials.flatMap((material) =>
        (material.textureBindings ?? []).map(
          (binding: { readonly textureIndex: number }) => binding.textureIndex,
        ),
      ),
    );
    for (const texture of textures) {
      if (!usedTextureIndices.has(texture.sourceIndex)) continue;
      subAssets.push({
        kind: 'texture',
        sourceIndex: texture.sourceIndex,
        guid: generateGuid(),
        sourceKey: textureSourceKey(texture),
        ...(texture.name ? { name: texture.name } : {}),
      });
    }

    // Always emit a scene sub-asset (the root container)
    subAssets.push({
      kind: 'scene',
      sourceIndex: 0,
      guid: generateGuid(),
      name: sourceName.replace(/\.fbx$/i, ''),
    });

    const sourceKeys = deriveFbxSourceKeys(subAssets);
    if (!sourceKeys.ok) {
      return { ok: false, error: `fbx-${sourceKeys.code}: name duplicate or anonymous outputs` };
    }
    const existingObject = existingMeta && typeof existingMeta === 'object'
      ? existingMeta as {
          subAssets?: readonly FbxSubAssetIdentity[];
          importSettings?: Readonly<Record<string, unknown>>;
          sourceOverrides?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
        }
      : undefined;
    const keyedSubAssets = reuseFbxSubAssetGuids(subAssets.map((entry, index) => {
      const sourceKey = sourceKeys.keys[index] as string;
      return {
        ...entry,
        sourceKey,
      };
    }), existingObject?.subAssets ?? []);
    const sourceOverrides: Record<string, Readonly<Record<string, unknown>>> = {
      ...(existingObject?.sourceOverrides ?? {}),
    };
    for (const mesh of meshes) {
      const meshOutput = keyedSubAssets.find(
        (entry) => entry.kind === 'mesh' && entry.sourceIndex === mesh.sourceIndex,
      );
      if (meshOutput?.sourceKey === undefined) continue;
      const current: MeshMaterialSlotTopologyEntry[] = [];
      const seenMaterials = new Set<number | null>();
      const usedNames = new Set<string>();
      const uniqueName = (raw: string): string => {
        const base = raw.trim() || 'Material';
        let candidate = base;
        let suffix = 2;
        while (usedNames.has(candidate)) candidate = `${base}_${suffix++}`;
        usedNames.add(candidate);
        return candidate;
      };
      for (const section of mesh.submeshes) {
        const materialIndex = section.materialIndex;
        if (seenMaterials.has(materialIndex)) continue;
        seenMaterials.add(materialIndex);
        const materialOutput = materialIndex === null
          ? undefined
          : keyedSubAssets.find(
              (entry) => entry.kind === 'material' && entry.sourceIndex === materialIndex,
            );
        current.push({
          slotName: uniqueName(
            materialIndex === null
              ? 'Default'
              : (materials[materialIndex]?.name ?? `Material_${materialIndex}`),
          ),
          sourceKey:
            materialIndex === null
              ? 'fbx:default'
              : (materialOutput?.sourceKey ?? `fbx:material:${materialIndex}`),
          ...(materialOutput === undefined ? {} : { defaultMaterialGuid: materialOutput.guid }),
        });
      }
      const previousPayload = existingObject?.sourceOverrides?.[meshOutput.sourceKey];
      const previousRaw = previousPayload?.materialSlots;
      const previous = Array.isArray(previousRaw)
        ? previousRaw.filter(
            (slot): slot is MeshMaterialSlotTopologyEntry =>
              slot !== null
              && typeof slot === 'object'
              && !Array.isArray(slot)
              && typeof (slot as { slotName?: unknown }).slotName === 'string',
          )
        : [];
      const reconciled = reconcileMeshMaterialSlotTopology(current, previous);
      if (!reconciled.ok) {
        return {
          ok: false,
          error: `${reconciled.error.code}: mesh ${meshOutput.guid}; ${reconciled.error.hint}`,
        };
      }
      sourceOverrides[meshOutput.sourceKey] = {
        ...(previousPayload ?? {}),
        materialSlots: reconciled.slots,
      };
    }

    const meta = {
      kind: 'external-asset-package',
      schemaVersion: '1.0.0',
      importer: 'fbx',
      source: sourceName,
      importSettings: mergeFbxImportSettings(existingObject, options.fbxCandidatePaths),
      subAssets: keyedSubAssets,
      sourceOverrides,
      sourceOverrideDescriptors: keyedSubAssets
        .filter((entry) => entry.kind === 'mesh')
        .map((entry) => ({
          sourceKey: entry.sourceKey,
          semantic: 'mesh-material-slot-defaults',
          payloadSchema: MESH_MATERIAL_SLOT_SOURCE_OVERRIDE_PAYLOAD_SCHEMA,
        })),
    };

    const byKind: Record<string, number> = {};
    for (const sa of keyedSubAssets) byKind[sa.kind] = (byKind[sa.kind] ?? 0) + 1;

    return {
      ok: true,
      metaJson: serializeMetaJson(meta),
      summary: { byKind, total: keyedSubAssets.length },
    };
  } catch (e) {
    return { ok: false, code: 'FBX_SOURCE_INVALID', error: (e as Error).message ?? String(e) };
  }
}
