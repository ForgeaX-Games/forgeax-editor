// gltf-cook.ts — frontend glTF → meta.json cook (single source of truth reuse).
//
// Reuses the engine's parseGlb / parseGltf / toAssetPack pipeline — the SAME
// SSOT the `forgeax-engine-console-gltf import` CLI uses (engine cli-gltf.ts
// `runWrite`) — to produce a canonical `external-asset-package` sidecar that
// includes a `scene` sub-asset and reimport-stable GUIDs. This replaces the
// platform-io `process-gltf` endpoint's hand-rolled meta, which omitted the
// `scene` sub-asset + canonical fields and was therefore rejected wholesale by
// `loadMetaAssets` (so NO sub-asset — not even mesh — showed in the browser).
//
// WHY this lives on the frontend (not platform-io): the 6-layer model (see
// architecture/layer-model.ts) classifies every `@forgeax/engine*` package as
// frontend L1; `platform-io` is backend L1 and `isAllowed(backend → frontend)`
// is false, so the backend cannot import engine-gltf. The editor (frontend L2)
// already depends on engine-gltf, and parse-gltf.ts is browser-clean (no
// `node:` imports), so the cook belongs here.
// Design: docs/design/gltf-import-meta-ssot-via-toassetpack.md.

import { parseGlb, parseGltf, toAssetPack } from '@forgeax/engine-gltf';

export interface GltfCookResult {
  readonly ok: boolean;
  /** Serialized canonical meta.json (sorted keys + trailing LF), ready to POST /api/files. */
  readonly metaJson?: string;
  /** Sub-asset counts by kind + total, for import-progress UI. */
  readonly summary?: { readonly byKind: Record<string, number>; readonly total: number };
  readonly error?: string;
}

// Byte-stable serialization mirroring engine cli-gltf.ts `serializeMetaJson`
// (deep-sorted keys + 2-space indent + trailing LF) so a clean reimport produces
// no diff.
// TODO(harness): replace with an engine-exported `serializeGltfMeta` once
// @forgeax/engine-gltf surfaces it (design doc §4.4) to drop this duplicate.
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) sorted[key] = sortKeysDeep(obj[key]);
    return sorted;
  }
  return value;
}

function serializeGltfMeta(meta: unknown): string {
  return `${JSON.stringify(sortKeysDeep(meta), null, 2)}\n`;
}

/**
 * Cook a .glb / .gltf source's raw bytes into a canonical meta.json string.
 *
 * @param bytes        raw source file bytes (the editor already holds the File at import time)
 * @param sourceName   basename written into `meta.source`, e.g. "bed.glb" (drives .glb vs .gltf dispatch)
 * @param existingMeta parsed existing `.meta.json`, passed through for reimport GUID reuse
 */
export async function cookGltfMeta(
  bytes: ArrayBuffer,
  sourceName: string,
  existingMeta?: unknown,
): Promise<GltfCookResult> {
  let docResult: Awaited<ReturnType<typeof parseGlb>>;
  if (/\.gltf$/i.test(sourceName)) {
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
      return { ok: false, error: `invalid .gltf JSON: ${(e as Error).message}` };
    }
    // No sibling resolver in-browser: embedded data-URI buffers/images cook
    // fine; a .gltf referencing external .bin/.png will surface this error
    // (self-contained .glb is the supported interactive-import form).
    const externalLoader = async (uri: string): Promise<ArrayBuffer> => {
      throw new Error(
        `external glTF resource '${uri}' unsupported in browser import — use a self-contained .glb`,
      );
    };
    docResult = await parseGltf(json, externalLoader, sourceName);
  } else {
    docResult = await parseGlb(bytes, sourceName);
  }

  if (!docResult.ok) {
    return { ok: false, error: `${docResult.error.code}: ${docResult.error.hint}` };
  }

  const existing = (existingMeta && typeof existingMeta === 'object'
    ? existingMeta
    : undefined) as Parameters<typeof toAssetPack>[1];
  const { meta } = toAssetPack(docResult.value, existing, sourceName);

  const byKind: Record<string, number> = {};
  for (const sa of meta.subAssets) byKind[sa.kind] = (byKind[sa.kind] ?? 0) + 1;

  return {
    ok: true,
    metaJson: serializeGltfMeta(meta),
    summary: { byKind, total: meta.subAssets.length },
  };
}
