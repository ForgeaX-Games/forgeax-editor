// Shared lifecycle seam for the entity, asset, and folder selection domains.
//
// Each domain owns its state and registers only its clear operation here. The
// seam coordinates cross-domain clears without importing any domain module,
// so selection modules do not form a dependency cycle.

export type SelectionDomain = 'entity' | 'asset' | 'folder';

type SelectionDomainClear = () => void;

const clearers: Record<SelectionDomain, SelectionDomainClear | undefined> = {
  entity: undefined,
  asset: undefined,
  folder: undefined,
};

export function registerSelectionDomainClear(
  domain: SelectionDomain,
  clear: SelectionDomainClear,
): () => void {
  clearers[domain] = clear;
  return () => {
    if (clearers[domain] === clear) clearers[domain] = undefined;
  };
}

export function clearSelectionDomains(...domains: SelectionDomain[]): void {
  for (const domain of domains) clearers[domain]?.();
}
