import { useCallback, useState } from 'react';
import type { CBViewMode } from '../types';

// The asset-view presentation layout (UE parity: tiles / list / details columns).
// Orthogonal to CBViewMode2 ('asset' | 'file', which is content ORGANIZATION):
// this is purely how the right-hand view PRESENTS the same items. Persisted per
// editor via localStorage so it survives reloads, like the panel widths.
const STORAGE_KEY = 'cb.layout';
const DEFAULT_LAYOUT: CBViewMode = 'grid';
const VALID: readonly CBViewMode[] = ['grid', 'list', 'column'];

/** Coerce a persisted/raw value to a valid layout, defaulting to tiles. Pure so
 *  the validation contract is unit-testable without a DOM. */
export function parseLayout(raw: string | null | undefined): CBViewMode {
  return raw && (VALID as readonly string[]).includes(raw) ? (raw as CBViewMode) : DEFAULT_LAYOUT;
}

function readInitial(): CBViewMode {
  try {
    return parseLayout(localStorage.getItem(STORAGE_KEY));
  } catch {
    // localStorage may be unavailable (SSR / privacy mode) — fall back to default.
    return DEFAULT_LAYOUT;
  }
}

/** Persisted asset-view layout mode. Returns the current mode + a stable setter
 *  that writes through to localStorage. */
export function useCBLayout(): readonly [CBViewMode, (mode: CBViewMode) => void] {
  const [layout, setLayoutState] = useState<CBViewMode>(readInitial);
  const setLayout = useCallback((mode: CBViewMode) => {
    setLayoutState(mode);
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // best-effort persistence; the in-memory state still updates.
    }
  }, []);
  return [layout, setLayout];
}
