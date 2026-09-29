// import-cook-catalog-apply — apply Host POST /__import success bodies to AssetRegistry.
//
// Engine already returns a scoped CatalogEntry[] on cook success; Editor previously
// discarded it and relied on poll barriers. This module pins rows locally and
// refreshes the catalog replica so Content Browser scriptable packs update without
// modifying packages/engine.

import type { AssetRegistry } from '@forgeax/engine-assets-runtime';

export interface ImportCookCatalogEntry {
  readonly guid: string;
  readonly kind?: string;
  readonly name?: string;
  readonly packageUrl?: string;
  readonly sourcePath?: string;
  readonly lifecycle?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function entryFromUnknown(value: unknown): ImportCookCatalogEntry | undefined {
  if (!isRecord(value) || typeof value.guid !== 'string' || value.guid.length === 0) return undefined;
  return {
    guid: value.guid,
    ...(typeof value.kind === 'string' ? { kind: value.kind } : {}),
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...(typeof value.packageUrl === 'string' ? { packageUrl: value.packageUrl } : {}),
    ...(typeof value.sourcePath === 'string' ? { sourcePath: value.sourcePath } : {}),
    ...(typeof value.lifecycle === 'string' ? { lifecycle: value.lifecycle } : {}),
  };
}

/** Parse legacy bare array or `{ entries }` receipt-shaped bodies. */
export function parseImportCookCatalogEntries(body: unknown): readonly ImportCookCatalogEntry[] {
  if (Array.isArray(body)) {
    return body.flatMap((item) => {
      const entry = entryFromUnknown(item);
      return entry === undefined ? [] : [entry];
    });
  }
  if (isRecord(body) && Array.isArray(body.entries)) {
    return body.entries.flatMap((item) => {
      const entry = entryFromUnknown(item);
      return entry === undefined ? [] : [entry];
    });
  }
  return [];
}

export function applyImportCookEntries(
  registry: AssetRegistry,
  entries: readonly ImportCookCatalogEntry[],
): number {
  if (entries.length === 0) return 0;
  let applied = 0;
  for (const entry of entries) {
    const key = entry.guid.toLowerCase();
    if (typeof entry.packageUrl === 'string' && entry.packageUrl.length > 0) {
      if (registry.packIndexCache === undefined) registry.packIndexCache = new Map();
      registry.packIndexCache.set(key, {
        packageUrl: entry.packageUrl,
        kind: typeof entry.kind === 'string' && entry.kind.length > 0 ? entry.kind : 'unknown',
        ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
      });
      registry.packFileCache?.delete(entry.packageUrl);
      applied += 1;
    }
  }
  return applied;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Give the Host watcher a short window, then pull pack-index (Editor-only priming). */
export async function primeCatalogBeforeCook(registry: AssetRegistry | undefined): Promise<void> {
  if (registry?.refreshCatalog === undefined) return;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await registry.refreshCatalog().catch(() => false);
    if (attempt < 2) await sleep(200);
  }
}

export async function applyImportCookResult(
  registry: AssetRegistry | undefined,
  entries: readonly ImportCookCatalogEntry[],
): Promise<void> {
  if (registry === undefined) return;
  applyImportCookEntries(registry, entries);
  await registry.refreshCatalog?.().catch(() => false);
}
