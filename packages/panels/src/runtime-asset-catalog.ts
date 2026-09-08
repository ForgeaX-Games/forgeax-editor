import { queryViewportRuntimeProjection } from '@forgeax/editor-core';
import type { SourceOverrideDescriptor } from '@forgeax/engine-types';

export interface RuntimeAssetCatalogRow {
  readonly guid: string;
  readonly kind: string;
  readonly name?: string;
  readonly packageUrl: string;
  readonly sourcePath?: string;
  readonly sourceKey?: string;
  readonly revision?: unknown;
  readonly sourceOverrides?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly sourceOverrideDescriptors?: readonly SourceOverrideDescriptor[];
}

interface RuntimeCatalogProjection {
  readonly entries: readonly RuntimeAssetCatalogRow[];
}

/** Read producer catalog facts from the one authoritative Viewport Runtime. */
export async function readRuntimeAssetCatalog(
  compatibleWith?: string,
): Promise<readonly RuntimeAssetCatalogRow[]> {
  const projected = await queryViewportRuntimeProjection<RuntimeCatalogProjection>({
    kind: 'assets.catalog',
    ...(compatibleWith === undefined ? {} : { compatibleWith }),
  });
  return projected.status === 'ready' && Array.isArray(projected.value?.entries)
    ? projected.value.entries
    : [];
}
