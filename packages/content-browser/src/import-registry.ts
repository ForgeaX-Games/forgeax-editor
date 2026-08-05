/** Compatibility entry for consumers migrating to the core-owned registry. */
export {
  IMPORT_FORMATS,
  buildAcceptString,
  getImportFormat,
  getImportRegistrySnapshot,
  getAllExtensions,
  isImportable,
  logImport,
} from '@forgeax/editor-core';
export type {
  ImportFormat,
  ImporterKey,
  SubAssetKind,
} from '@forgeax/editor-core';
