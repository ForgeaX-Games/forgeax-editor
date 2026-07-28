import { useCallback, useState } from 'react';

/**
 * Favorites — identity model.
 *
 * A favorite targets one of two DIFFERENT kinds of entity, and they must never
 * share a key:
 *   - assets live INSIDE a pack file (`Materials.pack.json` holds N materials),
 *     so their identity is the pack-schema `guid` — the same value renameAsset /
 *     duplicateAsset key on, stable across rename and across moving packs.
 *   - folders and disk files ARE paths, so their identity is the game-relative
 *     path.
 *
 * Keying assets on their containing file's path (the pre-fix behaviour) is
 * many-to-one: every material in `Materials.pack.json` — and the pack file card
 * itself — collapsed onto a single entry, so starring one lit them all.
 *
 * Stored keys are namespaced (`asset:<guid>` / `path:<rel>`) so the two spaces
 * cannot alias even if a path ever looked like a guid.
 */
export type CBFavoriteRef =
  | { kind: 'asset'; guid: string }
  | { kind: 'path'; path: string };

const STORAGE_PREFIX = 'forgeax.cb.favorites';
/** Pre-namespace store: one GLOBAL list of raw, unprefixed paths. */
const LEGACY_STORAGE_KEY = STORAGE_PREFIX;

export function favoriteKey(ref: CBFavoriteRef): string {
  return ref.kind === 'asset' ? `asset:${ref.guid}` : `path:${ref.path}`;
}

/** Favorites are per-game: the stored paths are game-relative, so a single
 *  global bucket would let two games' `assets/…` entries collide. */
function storageKey(gameSlug: string): string {
  return `${STORAGE_PREFIX}.${gameSlug || '__unscoped'}`;
}

function readList(key: string): string[] | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : null;
  } catch {
    return null;
  }
}

function loadFavorites(gameSlug: string): string[] {
  const current = readList(storageKey(gameSlug));
  if (current) return current;
  // One-way migration from the legacy global list. Its entries are bare paths;
  // an asset favorite in there is indistinguishable from a favorite on the pack
  // FILE (that ambiguity is the bug), so they all read as path favorites. The
  // legacy key is left in place: other games still migrate from it, and the
  // first write here shadows it for this game.
  const legacy = readList(LEGACY_STORAGE_KEY);
  return legacy ? legacy.map(path => favoriteKey({ kind: 'path', path })) : [];
}

function saveFavorites(gameSlug: string, keys: string[]): void {
  try {
    localStorage.setItem(storageKey(gameSlug), JSON.stringify(keys));
  } catch { /* storage full or unavailable */ }
}

export interface FavoritesAPI {
  isFavorite: (ref: CBFavoriteRef) => boolean;
  addFavorite: (ref: CBFavoriteRef) => void;
  removeFavorite: (ref: CBFavoriteRef) => void;
  toggleFavorite: (ref: CBFavoriteRef) => void;
}

export function useFavorites(gameSlug: string): FavoritesAPI {
  // Keyed by slug so switching games re-reads that game's bucket. Adjusting
  // state during render (React's documented "derive state from props" escape
  // hatch) keeps the swap flash-free — an effect would paint one frame of the
  // previous game's stars.
  const [state, setState] = useState(() => ({ slug: gameSlug, keys: loadFavorites(gameSlug) }));
  if (state.slug !== gameSlug) setState({ slug: gameSlug, keys: loadFavorites(gameSlug) });

  const isFavorite = useCallback((ref: CBFavoriteRef) => state.keys.includes(favoriteKey(ref)), [state.keys]);

  const mutate = useCallback((ref: CBFavoriteRef, mode: 'add' | 'remove' | 'toggle') => {
    setState(prev => {
      const key = favoriteKey(ref);
      const has = prev.keys.includes(key);
      if (mode === 'add' && has) return prev;
      if (mode === 'remove' && !has) return prev;
      const next = has ? prev.keys.filter(k => k !== key) : [...prev.keys, key];
      saveFavorites(prev.slug, next);
      return { slug: prev.slug, keys: next };
    });
  }, []);

  const addFavorite = useCallback((ref: CBFavoriteRef) => mutate(ref, 'add'), [mutate]);
  const removeFavorite = useCallback((ref: CBFavoriteRef) => mutate(ref, 'remove'), [mutate]);
  const toggleFavorite = useCallback((ref: CBFavoriteRef) => mutate(ref, 'toggle'), [mutate]);

  return { isFavorite, addFavorite, removeFavorite, toggleFavorite };
}
