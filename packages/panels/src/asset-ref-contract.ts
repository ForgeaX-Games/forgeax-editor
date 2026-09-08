import { gateway } from '@forgeax/editor-core';

/** Resolved display facts for a numeric shared-asset handle (0 = unbound). */
export interface ResolvedAssetBinding {
  readonly bound: boolean;
  readonly missing: boolean;
  readonly name: string;
  readonly guid?: string;
  readonly kind?: string;
  readonly meta?: Record<string, unknown>;
  readonly packPath?: string;
  readonly sourcePath?: string;
}

/** Read the producer-owned asset-union token for a component field (`shared<MeshAsset>` → `MeshAsset`). */
export function expectedAssetType(component: string, field: string): string | undefined {
  const described = gateway.describeComponent(component);
  if (!described.ok) return undefined;
  const raw = described.schema[field] ?? '';
  return /shared<([^>]+)>/.exec(raw)?.[1];
}

/** Resolve a runtime handle to catalog-backed display metadata for inspector widgets. */
export function resolveAssetHandle(handle: number): ResolvedAssetBinding {
  if (!Number.isFinite(handle) || handle <= 0) {
    return { bound: false, missing: false, name: '' };
  }
  const described = gateway.describeAsset(handle);
  if (!described.ok) {
    return { bound: true, missing: true, name: '' };
  }
  const name = (described.name && described.name.trim()) || (described.guid ? described.guid.slice(0, 8) : '');
  const catalog = described.guid
    ? gateway.assetCatalog().find((entry) => entry.guid === described.guid)
    : undefined;
  return {
    bound: true,
    missing: false,
    name,
    guid: described.guid,
    kind: described.kind,
    meta: described.meta as Record<string, unknown> | undefined,
    packPath: catalog?.packageUrl,
    sourcePath: catalog?.sourcePath,
  };
}

/** Resolve a catalog GUID to display metadata (material staging / texture slots). */
export function resolveAssetGuid(guid: string | null | undefined): ResolvedAssetBinding {
  if (!guid) return { bound: false, missing: false, name: '' };
  const described = gateway.describeAssetByGuid(guid);
  if (!described?.ok) {
    const catalog = gateway.assetCatalog().find((entry) => entry.guid === guid);
    if (!catalog) return { bound: true, missing: true, name: guid.slice(0, 8), guid };
    const name = (catalog.name && catalog.name.trim()) || guid.slice(0, 8);
    return {
      bound: true,
      missing: false,
      name,
      guid,
      kind: catalog.kind,
      packPath: catalog.packageUrl,
      sourcePath: catalog.sourcePath,
    };
  }
  const name = (described.name && described.name.trim()) || guid.slice(0, 8);
  return {
    bound: true,
    missing: false,
    name,
    guid,
    kind: described.kind,
    meta: described.meta as Record<string, unknown> | undefined,
    ...(() => {
      const catalog = gateway.assetCatalog().find((entry) => entry.guid === guid);
      return catalog
        ? { packPath: catalog.packageUrl, sourcePath: catalog.sourcePath }
        : {};
    })(),
  };
}

/** Authoritative compatibility check — same filter the AssetPicker catalog uses. */
export function isGuidCompatibleWithAssetType(guid: string, assetType: string): boolean {
  const result = gateway.assetCatalog({ compatibleWith: assetType });
  if (!result.ok) return false;
  return result.assets.some((row) => row.guid === guid);
}
