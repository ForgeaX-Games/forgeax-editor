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
  type FbxRawDocument,
  type FbxRawMesh,
  type FbxRawNodes,
  type FbxRawMaterial,
  type FbxRawSkeletonDoc,
  type FbxRawSkinDoc,
  type FbxRawAnimDoc,
} from '@forgeax/engine-fbx';

export interface FbxCookResult {
  readonly ok: boolean;
  readonly metaJson?: string;
  readonly summary?: { readonly byKind: Record<string, number>; readonly total: number };
  readonly error?: string;
}

// Mint a fresh asset GUID via the engine's authoritative generator
// (UUIDv7, dash-form string). AGENTS.md #1 / architecture-principles §2:
// never hand-roll a second GUID generator — the engine owns this.
function generateGuid(): string {
  return AssetGuid.format(AssetGuid.random());
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
      return { ok: false, error: `fbx-parse: ${maybeError.error.message}` };
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

    // Build existing GUID lookup for reimport stability
    const existingGuids = new Map<string, string>();
    if (existingMeta && typeof existingMeta === 'object') {
      const em = existingMeta as { subAssets?: readonly { kind: string; sourceIndex: number; guid: string }[] };
      for (const sa of em.subAssets ?? []) {
        existingGuids.set(`${sa.kind}:${sa.sourceIndex}`, sa.guid);
      }
    }

    function getGuid(kind: string, sourceIndex: number): string {
      return existingGuids.get(`${kind}:${sourceIndex}`) ?? generateGuid();
    }

    // Build sub-asset declarations
    const subAssets: { kind: string; sourceIndex: number; guid: string; name?: string }[] = [];

    for (const mesh of meshes) {
      subAssets.push({
        kind: 'mesh',
        sourceIndex: mesh.sourceIndex,
        guid: getGuid('mesh', mesh.sourceIndex),
        ...(mesh.name ? { name: mesh.name } : {}),
      });
    }

    for (let i = 0; i < materials.length; i++) {
      subAssets.push({
        kind: 'material',
        sourceIndex: i,
        guid: getGuid('material', i),
        ...(materials[i]?.name ? { name: materials[i]!.name } : {}),
      });
    }

    if (skeleton.jointCount > 0) {
      subAssets.push({
        kind: 'skeleton',
        sourceIndex: 0,
        guid: getGuid('skeleton', 0),
      });
    }

    if (skin.vertexCount > 0) {
      subAssets.push({
        kind: 'skin',
        sourceIndex: 0,
        guid: getGuid('skin', 0),
      });
    }

    for (let i = 0; i < animationClips.length; i++) {
      subAssets.push({
        kind: 'animation-clip',
        sourceIndex: i,
        guid: getGuid('animation-clip', i),
        ...(animationClips[i]?.name ? { name: animationClips[i]!.name } : {}),
      });
    }

    // Always emit a scene sub-asset (the root container)
    subAssets.push({
      kind: 'scene',
      sourceIndex: 0,
      guid: getGuid('scene', 0),
      name: sourceName.replace(/\.fbx$/i, ''),
    });

    const meta = {
      kind: 'external-asset-package',
      schemaVersion: '1.0.0',
      importer: 'fbx',
      source: sourceName,
      importSettings: {},
      subAssets,
    };

    const byKind: Record<string, number> = {};
    for (const sa of subAssets) byKind[sa.kind] = (byKind[sa.kind] ?? 0) + 1;

    return {
      ok: true,
      metaJson: serializeMetaJson(meta),
      summary: { byKind, total: subAssets.length },
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message ?? String(e) };
  }
}
