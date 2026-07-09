// store/last-selection-domain — the Derive of "who was selected last" that
// drives the keyboard router's dual-domain routing (AC-C1) AND the panel
// header scope indicators (T5-1 / C4-4 "add a visual clue, not an implicit
// rule").
//
// This is a SINGLE source of truth (architecture-principles Derive): the router
// (via interface submodule deps) and the UI panels both read it — there is no
// second divergent state. It is derived purely from the public selection emit
// signals, exactly as the router does:
//   - onSelectionChange   (entity forward-select) → 'entity'
//   - onAssetSelectionChange (asset forward-select) → 'asset'
//   - clear* does NOT advance it (lifecycle clear, C2-1)
// Initial value is 'entity' (T0-3: null → default 'entity').
//
// Anchors:
//   M4 T4-2 / AC-C1: lastSelectionDomain derive drives Delete/F2/Ctrl+D/Ctrl+A
//     domain routing. T5-1 / C4-4: same derive lights the panel header ring.
//   G-3: AI does NOT consume this as a contract — it is a keyboard-gesture
//     Derive only; keep it out of the op surface.
import { useSyncExternalStore } from 'react';
import { onSelectionChange } from './selection';
import { onAssetSelectionChange } from './asset-selection';

export type SelectionDomain = 'entity' | 'asset' | null;

let domain: SelectionDomain = 'entity';
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

/** Plain (non-React) read of the current Delete-jurisdiction domain. */
export function getLastSelectionDomain(): SelectionDomain {
  return domain;
}

/** Plain (non-React) subscription — used by the router DI in main.tsx. */
export function subscribeLastSelectionDomain(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Derive: forward selects advance the domain; clear* (lifecycle) does not.
onSelectionChange(() => {
  if (domain !== 'entity') { domain = 'entity'; emit(); }
});
onAssetSelectionChange(() => {
  if (domain !== 'asset') { domain = 'asset'; emit(); }
});

/** Reactive read for UI panels — lights the header scope ring. */
export function useLastSelectionDomain(): SelectionDomain {
  return useSyncExternalStore(
    subscribeLastSelectionDomain,
    getLastSelectionDomain,
    getLastSelectionDomain,
  );
}
