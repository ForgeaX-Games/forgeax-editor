import { AssetGuid } from '@forgeax/engine-pack/guid';
import { getImportFormat } from '../scan/ext-importer-map';

export interface ExistingSourceMetadata {
  readonly subAssets: readonly { readonly guid: string; readonly kind: string; readonly sourceIndex: number; readonly sourceKey?: string }[];
  readonly importSettings?: Readonly<Record<string, unknown>>;
  readonly sourceOverrides?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export type SourceMetadataResult =
  | { readonly ok: true; readonly metaJson: string }
  | { readonly ok: false; readonly code: string; readonly error: string };

/** One metadata producer shared by interactive import and scoped host recovery.
 * It performs no filesystem writes, catalog mutation or publication. */
export async function produceSourceMetadata(input: {
  readonly bytes: ArrayBuffer;
  readonly sourceName: string;
  readonly existing?: ExistingSourceMetadata;
  readonly firstGuid?: string;
  readonly fbxCandidatePaths?: readonly string[];
}): Promise<SourceMetadataResult> {
  const format = getImportFormat(input.sourceName);
  if (!format) return { ok: false, code: 'IMPORT_UNSUPPORTED_FORMAT', error: 'Unsupported source format.' };
  if (format.importer === 'gltf' || format.importer === 'fbx') {
    const cooked = format.importer === 'gltf'
      ? await (await import('./gltf-cook')).cookGltfMeta(input.bytes, input.sourceName, input.existing)
      : await (await import('./fbx-cook')).cookFbxMeta(input.bytes, input.sourceName, input.existing,
          input.fbxCandidatePaths === undefined ? {} : { fbxCandidatePaths: input.fbxCandidatePaths });
    if (cooked.ok && cooked.metaJson) return { ok: true, metaJson: cooked.metaJson };
    const code = 'code' in cooked && cooked.code === 'FBX_PARSE_FAILED' ? 'IMPORT_FBX_PARSE_FAILED'
      : 'code' in cooked && cooked.code === 'FBX_SOURCE_INVALID' ? 'IMPORT_FBX_SOURCE_INVALID'
      : 'IMPORT_COOK_FAILED';
    return { ok: false, code, error: cooked.error ?? `${format.importer} cook failed` };
  }
  const guid = input.existing?.subAssets[0]?.guid ?? input.firstGuid ?? AssetGuid.format(AssetGuid.random());
  const subAssets = format.subAssetKinds.map((kind, sourceIndex) => ({
    guid: input.existing?.subAssets.find((entry) => entry.kind === kind)?.guid
      ?? (sourceIndex === 0 ? guid : AssetGuid.format(AssetGuid.random())),
    sourceIndex,
    kind,
    ...(format.importer === 'font' ? { sourceKey: `font:${kind}` } : {}),
  }));
  return { ok: true, metaJson: JSON.stringify({
    schemaVersion: '1.0.0', kind: 'external-asset-package', importer: format.importer,
    source: input.sourceName,
    importSettings: { ...format.defaultSettings, ...(input.existing?.importSettings ?? {}) },
    ...(input.existing?.sourceOverrides === undefined ? {} : { sourceOverrides: input.existing.sourceOverrides }),
    subAssets,
  }, null, 2) + '\n' };
}
