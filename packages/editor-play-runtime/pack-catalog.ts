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

import { readFile } from 'node:fs/promises';
import { dirname, posix, relative, resolve } from 'node:path';
import { scan } from '@forgeax/engine-pack/scanner';
import { validateMeta } from '@forgeax/engine-pack/schema';
import type { CubeTextureMetadata, ImageMetadata, PackIndexEntry } from '@forgeax/engine-types';

// ── Types ──────────────────────────────────────────────────────────────

interface PackJson {
  readonly assets?: ReadonlyArray<{ guid: string; kind: string }>;
}

interface ExternalAssetMetaJson {
  readonly schemaVersion: string | number;
  readonly kind: 'external-asset-package';
  readonly assetType: 'image' | 'gltf' | 'audio';
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

// ── URL base prefixing ─────────────────────────────────────────────────
// The engine vite root uses `base: '/preview/'`, and the interface dev server
// only proxies `/preview/*` to the engine (packages/interface/vite.config:
// "Engine vite has base '/preview/', so ALL its asset/dep URLs are already
// prefixed"). The runtime fetches each catalog entry's `relativeUrl` verbatim
// from the iframe origin, so that URL MUST carry the `/preview` prefix —
// otherwise `/.forgeax/games/<slug>/assets/...` is not matched by the proxy,
// falls through to the interface SPA, returns index.html, and loadByGuid fails
// with `asset-fetch-failed`. Prefix the root-absolute source path with `base`.
function withBase(base: string, sourceRel: string): string {
  const rootAbs = posix.resolve('/', sourceRel); // -> /.forgeax/games/...
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
  if (metaObj.assetType === undefined) {
    return `sidecar ${rawPath} missing required 'assetType' field`;
  }
  if (metaObj.assetType !== 'image' && metaObj.assetType !== 'gltf' && metaObj.assetType !== 'audio') {
    return `sidecar ${rawPath} has invalid assetType: ${JSON.stringify(metaObj.assetType)}`;
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

  if (meta.assetType === 'image') {
    const metadata = buildImageMetadata(meta);
    let cubeMetadata: CubeTextureMetadata | undefined;
    for (const sub of meta.subAssets) {
      if (sub.kind === 'image') {
        out.push({ guid: sub.guid, relativeUrl: normalizedUrl, kind: 'texture', sourcePath: sourceRel, metadata });
      } else if (sub.kind === 'cube-texture') {
        if (cubeMetadata === undefined) {
          const faceSize = meta.importSettings.cubeFaceSize ?? 256;
          cubeMetadata = { kind: 'cube-texture', width: faceSize, height: faceSize, format: 'rgba16float', colorSpace: 'linear', mipLevels: 1 };
        }
        out.push({ guid: sub.guid, relativeUrl: normalizedUrl, kind: 'cube-texture', sourcePath: sourceRel, metadata: cubeMetadata });
      }
    }
  }

  if (meta.assetType === 'audio') {
    for (const sub of meta.subAssets) {
      if (sub.kind === 'audio') {
        out.push({ guid: sub.guid, relativeUrl: normalizedUrl, kind: 'audio', sourcePath: sourceRel });
      }
    }
  }

  if (meta.assetType === 'gltf') {
    for (const sub of meta.subAssets) {
      if (sub.kind === 'mesh' || sub.kind === 'material' || sub.kind === 'scene') {
        out.push({ guid: sub.guid, relativeUrl: normalizedUrl, kind: sub.kind, sourcePath: sourceRel });
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
 */
export async function buildPerGameCatalog(root: string, base = '/preview'): Promise<PackIndexEntry[]> {
  const roots: readonly string[] = [root];
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
      for (const asset of parsed.assets ?? []) {
        catalog.push({
          guid: asset.guid,
          relativeUrl: normalizedUrl,
          kind: asset.kind,
          sourcePath: rel,
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