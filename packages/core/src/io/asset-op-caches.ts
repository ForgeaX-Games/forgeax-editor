// Async asset-op inverse caches. Kept dependency-free so pack-ops can consume
// them without importing AssetIOFacade back through the facade's low-level IO
// imports (which would create a core dependency cycle).
export const deletedEntryCache = new Map<string, unknown>();
export const renamedNameCache = new Map<string, string>();
export const duplicatedGuidCache = new Map<string, string>();
