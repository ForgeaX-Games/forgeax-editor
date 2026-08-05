import { authoringCapabilityForAssetKind, type AssetAuthoringCapability } from '@forgeax/engine-types';

export interface CompatibleAssetCatalogError {
  readonly code: 'asset-compatibility-token-unknown';
  readonly expected: 'producer authoring binding target assetType';
  readonly actual: string;
  readonly hint: string;
  readonly retryable: false;
}

export type CompatibleAssetCatalogResult<Row> =
  | { readonly ok: true; readonly assets: readonly Row[] }
  | { readonly ok: false; readonly error: CompatibleAssetCatalogError };

export interface CompatibleAssetCatalogRow {
  readonly kind: string;
  readonly authoring?: AssetAuthoringCapability;
}

function capabilityFor(row: CompatibleAssetCatalogRow): AssetAuthoringCapability {
  return row.authoring ?? authoringCapabilityForAssetKind(row.kind);
}

function assetTypeOf(row: CompatibleAssetCatalogRow): string | undefined {
  const binding = capabilityFor(row).binding;
  return binding.operation === 'unavailable' ? undefined : binding.target.assetType;
}

export function queryCompatibleAssetCatalog<Row extends CompatibleAssetCatalogRow>(
  rows: readonly Row[],
  compatibleWith: string,
  knownAssetTypes: Iterable<string> = rows.flatMap((row) => {
    const assetType = assetTypeOf(row);
    return assetType === undefined ? [] : [assetType];
  }),
): CompatibleAssetCatalogResult<Row> {
  const known = new Set(knownAssetTypes);
  if (!known.has(compatibleWith)) {
    return {
      ok: false,
      error: {
        code: 'asset-compatibility-token-unknown',
        expected: 'producer authoring binding target assetType',
        actual: compatibleWith,
        hint: "Read the producer field token with describeComponent('ParticleEffectPlayer') before querying compatible assets.",
        retryable: false,
      },
    };
  }
  return { ok: true, assets: rows.filter((row) => assetTypeOf(row) === compatibleWith) };
}
