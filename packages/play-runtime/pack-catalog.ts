// pack-catalog.ts - per-root catalog builder (path c)
//
// Builds a PackIndexEntry[] for a single asset root, reusing
// @forgeax/engine-pack/scanner + /schema (open sub-path exports) to
// avoid touching the engine repository.
//
// Two-arm dispatch (replicating build-catalog.ts:128-334):
//   - .pack.json  -- legacy arm: one 4-field entry per assets[] row
//   - .meta.json  -- external arm: image/gltf/audio subAssets with metadata
//
// Scan errors degrade to [] + console.warn (matching existing buildCatalog
// behavior; the GUID-collision silent-degrade is a charter-P3 gap tracked
// as OOS-5 and not addressed here).

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, posix, relative, resolve } from 'node:path';
import { deriveAssetName } from '@forgeax/engine-pack/name';
import { scan } from '@forgeax/engine-pack/scanner';
import { validateMeta } from '@forgeax/engine-pack/schema';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import type { ImageMetadata, PackIndexEntry, TextureAsset } from '@forgeax/engine-types';

// The engine retired its `CubeTextureMetadata` type (cube-texture → equirect
// internalization). This catalog still emits a cube-texture sidecar row for
// legacy sky.hdr assets; keep the historical metadata shape as a LOCAL type so
// the emitted JSON is byte-identical to before (it was `any`-typed via the old
// engine shim). PackIndexEntry.metadata only types ImageMetadata, so the row's
// metadata is cast at the push below.
interface CubeTextureMetadata {
  readonly kind: 'cube-texture';
  readonly width: number;
  readonly height: number;
  readonly format: string;
  readonly colorSpace: 'srgb' | 'linear';
  readonly mipLevels: number;
}

// ── Types ──────────────────────────────────────────────────────────────

interface PackJson {
  readonly assets?: ReadonlyArray<{ guid: string; kind: string; name?: string }>;
}

interface ExternalAssetMetaJson {
  readonly schemaVersion: string | number;
  readonly kind: 'external-asset-package';
  // feat-20260603-asset-import-loader-injection M2: the engine replaced the
  // closed `assetType` enum with the open `importer` key (one-cut migration,
  // no shim). This replica must read `importer` to match meta.schema.json and
  // the engine's build-catalog.ts; reading `assetType` rejected every sidecar.
  readonly importer: 'image' | 'gltf' | 'audio' | 'font';
  readonly source: string;
  readonly importSettings: {
    readonly colorSpace?: 'srgb' | 'linear';
    readonly mipmap?: 'auto' | 'none';
    readonly cubeFaceSize?: number;
    readonly specularMipLevels?: number;
  };
  readonly subAssets: ReadonlyArray<{
    readonly guid: string;
    readonly sourceIndex: number;
    readonly kind: string;
    /** Optional display name from the source (e.g. glTF mesh.name); derived from
     *  the source basename when absent (deriveAssetName), mirroring the engine's
     *  build-catalog.ts so a runtime-imported GLB's sub-assets are not blank in
     *  the Content Browser. */
    readonly name?: string;
  }>;
}

// ── Helpers ────────────────────────────────────────────────────────────

function mipmapTokenToBoolean(token: 'auto' | 'none' | undefined): boolean {
  return token === 'auto';
}

function colorSpaceToFormat(colorSpace: 'srgb' | 'linear' | undefined): GPUTextureFormat {
  return colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm';
}

function buildImageMetadata(meta: ExternalAssetMetaJson): ImageMetadata {
  const colorSpace: 'srgb' | 'linear' = meta.importSettings.colorSpace ?? 'linear';
  return {
    kind: 'texture',
    format: colorSpaceToFormat(colorSpace),
    colorSpace,
    mipmap: mipmapTokenToBoolean(meta.importSettings.mipmap),
  };
}

// Bake an `.hdr` equirect source into the rgba16float RGBA `.bin` the runtime
// requires (it no longer decodes `.hdr` inline -- it reads ONLY a build-time
// imported `.bin`; see asset-registry loadFromUpstreamEntry). We cook it HERE,
// at per-game catalog build, via the same imageImporter the engine uses, then
// point the catalog row directly at the `.bin` with the CORRECT rgba16float
// metadata. This avoids the dev `POST /__import` round-trip whose engine-side
// importTextureEntry mislabels the imported HDR as rgba8unorm -- which makes
// uploadCubemapFromEquirect reject the source with `invalid-source-format`.
// Cached on disk (cook only when the `.bin` + its dims sidecar are absent).
async function bakeHdrEquirect(
  sourceAbsPath: string,
  guid: string,
): Promise<{ binAbsPath: string; width: number; height: number } | null> {
  const guidLower = guid.toLowerCase();
  const binAbsPath = `${sourceAbsPath}.${guidLower}.bin`;
  const dimsPath = `${binAbsPath}.dims.json`;
  try {
    const [binStat, dimsRaw] = await Promise.all([stat(binAbsPath), readFile(dimsPath, 'utf-8')]);
    if (binStat.size > 0) {
      const dims = JSON.parse(dimsRaw) as { width: number; height: number };
      return { binAbsPath, width: dims.width, height: dims.height };
    }
  } catch {
    // No cached .bin/dims -> cook below.
  }

  let src: Uint8Array;
  try {
    src = new Uint8Array(await readFile(sourceAbsPath));
  } catch (e) {
    console.warn(`[forgeax-pack] hdr bake: cannot read ${sourceAbsPath}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  const ctx = {
    source: sourceAbsPath,
    readSource: async () => ({ ok: true as const, value: src }),
    readSibling: async () => ({ ok: true as const, value: new Uint8Array() }),
    decodeImage: async () => {
      throw new Error('decodeImage seam unused on the .hdr bare-source bake path');
    },
    subAssets: [{ guid, sourceIndex: 0, kind: 'image' as const }],
    importSettings: { colorSpace: 'linear' as const, mipmap: false },
  };
  let produced: readonly { guid: string; payload: unknown }[];
  try {
    produced = await imageImporter.import(ctx as never);
  } catch (e) {
    console.warn(`[forgeax-pack] hdr bake: importer threw for ${sourceAbsPath}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  const tex = produced.find((a) => a.guid.toLowerCase() === guidLower)?.payload as TextureAsset | undefined;
  if (tex === undefined) {
    console.warn(`[forgeax-pack] hdr bake: importer produced no asset for ${sourceAbsPath}`);
    return null;
  }
  const bytes =
    tex.data instanceof Uint8Array
      ? tex.data
      : new Uint8Array(tex.data.buffer, tex.data.byteOffset, tex.data.byteLength);
  try {
    await mkdir(dirname(binAbsPath), { recursive: true });
    await writeFile(binAbsPath, bytes);
    await writeFile(dimsPath, JSON.stringify({ width: tex.width, height: tex.height }));
  } catch (e) {
    console.warn(`[forgeax-pack] hdr bake: write failed for ${binAbsPath}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  return { binAbsPath, width: tex.width, height: tex.height };
}

// ── URL base prefixing ─────────────────────────────────────────────────
// The engine vite root uses `base: '/preview/'`, and the interface dev server
// only proxies `/preview/*` to the engine (packages/interface/vite.config:
// "Engine vite has base '/preview/', so ALL its asset/dep URLs are already
// prefixed"). The runtime fetches each catalog entry's `relativeUrl` verbatim
// from the iframe origin, so that URL MUST carry the `/preview` prefix —
// otherwise the game-relative asset URL is not matched by the proxy,
// falls through to the interface SPA, returns index.html, and loadByGuid fails
// with `asset-fetch-failed`. Prefix the root-absolute source path with `base`.
function withBase(base: string, sourceRel: string): string {
  const rootAbs = posix.resolve('/', sourceRel); // root-absolute game asset path
  const prefix = base.replace(/\/$/, ''); // '/preview/' -> '/preview'
  return prefix ? `${prefix}${rootAbs}` : rootAbs;
}

// ── Sidecar processor ──────────────────────────────────────────────────

async function processMetaSidecar(
  rawPath: string,
  cwd: string,
  out: PackIndexEntry[],
  base: string,
): Promise<string | null> {
  let metaRaw: unknown;
  try {
    const content = await readFile(rawPath, 'utf-8');
    metaRaw = JSON.parse(content);
  } catch (e) {
    return `failed to read or parse sidecar ${rawPath}: ${e instanceof Error ? e.message : String(e)}`;
  }

  const metaObj = (metaRaw ?? {}) as Record<string, unknown>;
  if (typeof metaObj.importer !== 'string' || metaObj.importer.length === 0) {
    return `sidecar ${rawPath} missing required 'importer' field`;
  }
  if (metaObj.importer !== 'image' && metaObj.importer !== 'gltf' && metaObj.importer !== 'audio') {
    return `sidecar ${rawPath} has unfoldable importer: ${JSON.stringify(metaObj.importer)}`;
  }

  const valid = validateMeta(metaRaw);
  if (!valid) {
    const ajvErrs = (validateMeta.errors ?? []).map(
      (e) => `${e.instancePath ?? '/'} ${e.message ?? ''}`,
    );
    return `sidecar ${rawPath} fails meta.schema.json validation: ${ajvErrs.join('; ')}`;
  }

  const meta = metaRaw as ExternalAssetMetaJson;
  const sidecarDir = dirname(rawPath);
  const sourceAbsPath = resolve(sidecarDir, meta.source);
  const sourceRel = relative(cwd, sourceAbsPath).replace(/\\/g, '/');
  const normalizedUrl = withBase(base, sourceRel);

  // Mirror the engine's build-catalog.ts: the source file is the "package", each
  // subAsset an artifact from it. deriveAssetName applies the XOR name rule
  // (single-/no-storedName sub-asset -> source basename), so a GLB's 1000+
  // sub-assets show as "<file>.glb" in the Content Browser instead of blank.
  const subAssetCount = meta.subAssets.length;
  const subName = (sub: { readonly name?: string }): string =>
    deriveAssetName(sourceAbsPath, subAssetCount, sub.name);

  if (meta.importer === 'image') {
    const metadata = buildImageMetadata(meta);
    const isHdr = meta.source.toLowerCase().endsWith('.hdr');
    let cubeMetadata: CubeTextureMetadata | undefined;
    for (const sub of meta.subAssets) {
      if (sub.kind === 'equirect') {
        // feat-20260630-equirect-kind-internalized-ibl: an .hdr equirect
        // sub-asset folds to a kind:'equirect' row carrying rgba16float
        // ImageMetadata (mirrors the engine SSOT build-catalog.ts equirect arm).
        // The engine build-catalog leaves relativeUrl at the raw .hdr and relies
        // on pluginPack's importer to emit the .bin; this dev per-game route has
        // NO importer emit step, so we bake the rgba16float .bin here (cached)
        // and point the row directly at it, exactly like the pre-feat image+HDR
        // path did. Without this branch the sub-asset was silently dropped (the
        // old loop only knew 'image'/'cube-texture'), leaving Skylight.equirect
        // with no catalog row -> load-failed:asset-not-imported.
        const baked = isHdr ? await bakeHdrEquirect(sourceAbsPath, sub.guid) : null;
        if (baked !== null) {
          const binRel = relative(cwd, baked.binAbsPath).replace(/\\/g, '/');
          out.push({
            guid: sub.guid,
            relativeUrl: withBase(base, binRel),
            kind: 'equirect',
            sourcePath: sourceRel,
            metadata: {
              kind: 'texture',
              width: baked.width,
              height: baked.height,
              format: 'rgba16float',
              colorSpace: 'linear',
              mipmap: false,
            },
          });
        } else {
          // Bake failed / non-.hdr source -> raw equirect row (loadByGuid then
          // tries the dev /__import cook as a best-effort fallback).
          out.push({ guid: sub.guid, relativeUrl: normalizedUrl, kind: 'equirect', sourcePath: sourceRel, metadata });
        }
      } else if (sub.kind === 'image') {
        if (isHdr) {
          const baked = await bakeHdrEquirect(sourceAbsPath, sub.guid);
          if (baked !== null) {
            const binRel = relative(cwd, baked.binAbsPath).replace(/\\/g, '/');
            out.push({
              guid: sub.guid,
              relativeUrl: withBase(base, binRel),
              kind: 'texture',
              sourcePath: sourceRel,
              name: subName(sub),
              metadata: {
                kind: 'texture',
                width: baked.width,
                height: baked.height,
                format: 'rgba16float',
                colorSpace: 'linear',
                mipmap: false,
              },
            });
            continue;
          }
          // Bake failed -> fall through to the raw .hdr row (loadByGuid then
          // tries the dev /__import cook as a best-effort fallback).
        }
        out.push({ guid: sub.guid, relativeUrl: normalizedUrl, kind: 'texture', sourcePath: sourceRel, name: subName(sub), metadata });
      } else if (sub.kind === 'cube-texture') {
        if (cubeMetadata === undefined) {
          const faceSize = meta.importSettings.cubeFaceSize ?? 256;
          cubeMetadata = { kind: 'cube-texture', width: faceSize, height: faceSize, format: 'rgba16float', colorSpace: 'linear', mipLevels: 1 };
        }
        // metadata is a cube-texture shape (see CubeTextureMetadata above); the
        // PackIndexEntry.metadata field types only ImageMetadata, so cast to keep
        // the emitted row identical to the pre-typecheck (any-shim) output.
        out.push({ guid: sub.guid, relativeUrl: normalizedUrl, kind: 'cube-texture', sourcePath: sourceRel, name: subName(sub), metadata: cubeMetadata as unknown as ImageMetadata });
      }
    }
  }

  if (meta.importer === 'audio') {
    for (const sub of meta.subAssets) {
      if (sub.kind === 'audio') {
        out.push({ guid: sub.guid, relativeUrl: normalizedUrl, kind: 'audio', sourcePath: sourceRel, name: subName(sub) });
      }
    }
  }

  if (meta.importer === 'gltf') {
    // gltfImporter emits up to 8+ sub-asset kinds: mesh / material / scene /
    // texture / skeleton / skin + N animation-clip. The runtime resolves them
    // all through the same .glb source URL — gltfImporter's transform hook
    // re-parses the GLB and emits the right POD per (guid, sourceIndex) lookup.
    // Without listing every kind here, loadByGuid for the missing rows would
    // hit asset-not-imported, defeating skinned-mesh + animation playback.
    const GLTF_KINDS = new Set(['mesh', 'material', 'scene', 'texture', 'skeleton', 'skin', 'animation-clip']);
    for (const sub of meta.subAssets) {
      if (GLTF_KINDS.has(sub.kind)) {
        out.push({ guid: sub.guid, relativeUrl: normalizedUrl, kind: sub.kind, sourcePath: sourceRel, name: subName(sub) });
      }
    }
  }

  return null;
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Build a pack-index catalog for a single asset root.
 *
 * Two-arm dispatch:
 *   - .pack.json -> legacy 4-field entry per assets[] row
 *   - .meta.json -> image/gltf/audio arm with metadata sub-structure
 *
 * Returns [] on scan error (dev-mode degrade over crash).
 *
 * `base` is the engine vite root's base (default `/preview`). Every entry's
 * `relativeUrl` is prefixed with it so the runtime's `fetch(relativeUrl)` from
 * the iframe origin hits the engine through the interface's `/preview/*` proxy
 * (see withBase). Pass '' to emit unprefixed root-absolute URLs.
 *
 * `extraRoots` are SHARED asset dirs (e.g. the template's sky.hdr cube-texture)
 * folded into every game's per-game catalog so template-provided assets resolve
 * by GUID without being duplicated into each game's assets/ dir. Their sources
 * must live under the engine vite root so `relative(cwd, ...)` + base yields a
 * URL vite can serve.
 */
export async function buildPerGameCatalog(
  root: string,
  base = '/preview',
  extraRoots: readonly string[] = [],
): Promise<PackIndexEntry[]> {
  const roots: readonly string[] = [root, ...extraRoots];
  const cwd = process.cwd();
  const result = await scan(roots);
  if (!result.ok) {
    console.warn('[forgeax-pack] scan error:', result.error.message);
    return [];
  }

  const catalog: PackIndexEntry[] = [];
  const errors: string[] = [];
  for (const rawPath of result.value) {
    if (rawPath.endsWith('.meta.json') && !rawPath.endsWith('.pack.json')) {
      const err = await processMetaSidecar(rawPath, cwd, catalog, base);
      if (err) errors.push(err);
      continue;
    }

    if (!rawPath.endsWith('.pack.json')) continue;
    try {
      const content = await readFile(rawPath, 'utf-8');
      const parsed = JSON.parse(content) as PackJson;
      const rel = relative(cwd, rawPath).replace(/\\/g, '/');
      const normalizedUrl = withBase(base, rel);
      const assetList = parsed.assets ?? [];
      // .pack.json arm: the pack file IS the package (deriveAssetName rule 1/2/3
      // keyed on assetList.length), mirroring engine build-catalog.ts foldPaths.
      for (const asset of assetList) {
        catalog.push({
          guid: asset.guid,
          relativeUrl: normalizedUrl,
          kind: asset.kind,
          sourcePath: rel,
          name: deriveAssetName(rawPath, assetList.length, asset.name),
        });
      }
    } catch {
      // Skip malformed pack files in dev mode.
    }
  }
  if (errors.length > 0) {
    for (const e of errors) {
      console.warn(`[forgeax-pack] catalog meta error: ${e}`);
    }
  }
  return catalog;
}