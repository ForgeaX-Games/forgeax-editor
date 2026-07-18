// Per-provider "last hand-picked model" memory.
//
// Two distinct gestures land on different defaults, and conflating them was the
// reported bug:
//   • Switching PROVIDER is a deliberate "give me this provider's default" — it
//     resets the active session to the provider's catalog default
//     (resetActiveAgentModelToProviderDefault). We do NOT record that here.
//   • Creating a NEW SESSION should resume "where I left off" for the current
//     provider — the model the user last HAND-PICKED in the composer. Only the
//     manual pick writes here; new sessions read it to seed their agent model.
//
// Keyed by catalog-provider id: a CLI driver id (claude-code / codex / …) or
// 'forgeax' for the native gateway path (catalogProviderId === null).

import { STORAGE_KEYS } from './storageKeys';

const KEY = STORAGE_KEYS.lastModelByProvider;

function providerKey(catalogProviderId: string | null): string {
  return catalogProviderId && catalogProviderId !== 'forgeax' ? catalogProviderId : 'forgeax';
}

function readMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
    return {};
  } catch {
    return {};
  }
}

/** The model the user last hand-picked for this provider, or null if none. */
export function getLastModel(catalogProviderId: string | null): string | null {
  const v = readMap()[providerKey(catalogProviderId)];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Record a HAND-PICKED model for this provider (called from the composer's
 *  model picker onChange — never from a provider-switch reset). */
export function recordLastModel(catalogProviderId: string | null, modelId: string): void {
  if (!modelId) return;
  try {
    const map = readMap();
    map[providerKey(catalogProviderId)] = modelId;
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* ignore (private mode / SSR) */
  }
}
