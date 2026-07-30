// pack-catalog.ts - per-game Pack v2 catalog projection.
//
// The editor's per-game route must emit the same navigation-only catalog
// contract as the engine's global vite-pack plugin. Payload facts belong inside
// Pack v2; rows therefore contain a GUID, a cooked package URL, and source
// navigation metadata only.

import { readFile } from 'node:fs/promises';
import { dirname, posix, relative, resolve } from 'node:path';
import { deriveAssetName } from '@forgeax/engine-pack/name';
import { scan } from '@forgeax/engine-pack/scanner';
import { validateMeta } from '@forgeax/engine-pack/schema';
import type { PackIndexEntry } from '@forgeax/engine-types';

/** Dedupe scan-failure logs per root-set for this process (HTTP hot path). */
const loggedScanFailureKeys = new Set<string>();

interface PackJson {
  readonly assets?: ReadonlyArray<{
    readonly guid: string;
    readonly kind: string;
    readonly name?: string;
    readonly refs?: readonly string[];
  }>;
}

interface ExternalAssetMetaJson {
  readonly schemaVersion: string | number;
  readonly kind: 'external-asset-package';
  readonly importer: string;
  readonly source: string;
  readonly subAssets: ReadonlyArray<{
    readonly guid: string;
    readonly sourceIndex: number;
    readonly kind: string;
    readonly name?: string;
  }>;
}

/** Prefix a root-absolute path with the engine Vite base. */
function withBase(base: string, sourceRel: string): string {
  const rootAbs = posix.resolve('/', sourceRel);
  const prefix = base.replace(/\/$/, '');
  return prefix ? `${prefix}${rootAbs}` : rootAbs;
}

/**
 * Every external source is represented by the cooked package that the global
 * pluginPack instance exposes. A source file must never appear as a catalog
 * locator: assets-runtime rejects raw locators before attempting a load.
 */
function metaPackageUrl(_base: string, firstGuid: string | undefined): string {
  const packageName = firstGuid === undefined ? 'pack' : firstGuid.toLowerCase();
  // DDC is a host-level transport route, not a Vite base asset. Studio proxies
  // `/__forgeax-ddc/*` from :18920 to the Play server, while `/preview/*`
  // falls through to Vite's SPA and returns index.html. Keep this URL root-
  // relative even though ordinary pack files carry the `/preview` base.
  return `/__forgeax-ddc/${packageName}.pack.json`;
}

async function processMetaSidecar(
  rawPath: string,
  cwd: string,
  out: PackIndexEntry[],
  base: string,
): Promise<string | null> {
  let metaRaw: unknown;
  try {
    metaRaw = JSON.parse(await readFile(rawPath, 'utf-8'));
  } catch (error) {
    return `failed to read or parse sidecar ${rawPath}: ${error instanceof Error ? error.message : String(error)}`;
  }

  const metaObj = (metaRaw ?? {}) as Record<string, unknown>;
  if (typeof metaObj.importer !== 'string' || metaObj.importer.length === 0) {
    return `sidecar ${rawPath} missing required 'importer' field`;
  }
  if (!validateMeta(metaRaw)) {
    const errors = (validateMeta.errors ?? []).map((error) => `${error.instancePath ?? '/'} ${error.message ?? ''}`);
    return `sidecar ${rawPath} fails meta.schema.json validation: ${errors.join('; ')}`;
  }

  const meta = metaRaw as unknown as ExternalAssetMetaJson;
  const sourceAbsPath = resolve(dirname(rawPath), meta.source);
  const sourceRel = relative(cwd, sourceAbsPath).replace(/\\/g, '/');
  const packageUrl = metaPackageUrl(base, meta.subAssets[0]?.guid);
  const subAssetCount = meta.subAssets.length;

  for (const sub of meta.subAssets) {
    out.push({
      guid: sub.guid,
      packageUrl,
      kind: sub.kind,
      sourcePath: sourceRel,
      name: deriveAssetName(sourceAbsPath, subAssetCount, sub.name),
    });
  }
  return null;
}

/**
 * Build a Pack v2 catalog for a single game's declared asset roots.
 *
 * Pack files retain their own URLs. External sidecars point every sub-asset at
 * the cooked `/__forgeax-ddc/<first-guid>.pack.json` package emitted by the
 * shared global pluginPack instance, mirroring the engine's catalog builder.
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
    const failureKey = roots.join('\0');
    if (!loggedScanFailureKeys.has(failureKey)) {
      loggedScanFailureKeys.add(failureKey);
      console.warn('[forgeax-pack] scan error:', result.error.message);
    }
    return [];
  }

  const catalog: PackIndexEntry[] = [];
  const errors: string[] = [];
  for (const rawPath of result.value) {
    if (rawPath.endsWith('.meta.json') && !rawPath.endsWith('.pack.json')) {
      const error = await processMetaSidecar(rawPath, cwd, catalog, base);
      if (error) errors.push(error);
      continue;
    }
    if (!rawPath.endsWith('.pack.json')) continue;
    try {
      const parsed = JSON.parse(await readFile(rawPath, 'utf-8')) as PackJson;
      const sourcePath = relative(cwd, rawPath).replace(/\\/g, '/');
      const packageUrl = withBase(base, sourcePath);
      const assets = parsed.assets ?? [];
      for (const asset of assets) {
        catalog.push({
          guid: asset.guid,
          packageUrl,
          kind: asset.kind,
          sourcePath,
          name: deriveAssetName(rawPath, assets.length, asset.name),
          ...(asset.refs === undefined ? {} : { refs: asset.refs }),
        });
      }
    } catch {
      // A malformed source pack is ignored in the development route; the
      // global plugin reports its structured catalog diagnostic independently.
    }
  }
  for (const error of errors) console.warn(`[forgeax-pack] catalog meta error: ${error}`);
  return catalog;
}
