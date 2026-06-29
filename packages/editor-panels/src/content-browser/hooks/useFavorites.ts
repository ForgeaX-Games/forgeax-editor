import { useCallback, useState } from 'react';

const STORAGE_KEY = 'forgeax.cb.favorites';

function loadFavorites(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveFavorites(paths: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(paths));
  } catch { /* storage full or unavailable */ }
}

export interface FavoritesAPI {
  favorites: string[];
  isFavorite: (path: string) => boolean;
  addFavorite: (path: string) => void;
  removeFavorite: (path: string) => void;
  toggleFavorite: (path: string) => void;
}

export function useFavorites(): FavoritesAPI {
  const [favorites, setFavorites] = useState<string[]>(loadFavorites);

  const isFavorite = useCallback((path: string) => favorites.includes(path), [favorites]);

  const addFavorite = useCallback((path: string) => {
    setFavorites(prev => {
      if (prev.includes(path)) return prev;
      const next = [...prev, path];
      saveFavorites(next);
      return next;
    });
  }, []);

  const removeFavorite = useCallback((path: string) => {
    setFavorites(prev => {
      const next = prev.filter(p => p !== path);
      saveFavorites(next);
      return next;
    });
  }, []);

  const toggleFavorite = useCallback((path: string) => {
    setFavorites(prev => {
      const next = prev.includes(path) ? prev.filter(p => p !== path) : [...prev, path];
      saveFavorites(next);
      return next;
    });
  }, []);

  return { favorites, isFavorite, addFavorite, removeFavorite, toggleFavorite };
}
