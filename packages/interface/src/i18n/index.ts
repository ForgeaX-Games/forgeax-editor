/**
 * Lightweight i18n core for the Studio interface.
 *
 * Design (see /Users/you/ForgeaX/I18N-REFACTOR-PLAN.md):
 *   - English is the SOURCE OF TRUTH. `locales/en.json` holds the English UI
 *     copy; reading it ≈ reading the English UI. Keys are English semantic
 *     identifiers. AI / developers read English everywhere; other languages are
 *     a user-facing overlay only.
 *   - Zero external deps. The public API is deliberately shaped like
 *     `react-i18next` (`useTranslation() → { t }`, `t(key, vars)`,
 *     `changeLanguage`, `{{var}}` interpolation) so it feels familiar and could
 *     be swapped for the real library later with near-zero churn.
 *   - Module-level store + `useSyncExternalStore`, matching this repo's
 *     hand-rolled store style (see StatusBar/store.ts, SettingsPanel/store.ts).
 *
 * Lookup order for any key: current locale → English → the key string itself.
 */

import { useSyncExternalStore } from 'react';
import en from './locales/en.json';
import zh from './locales/zh.json';
import { STORAGE_KEYS } from '../lib/storageKeys';
import { flushBrowserPrefs } from '../lib/browser-prefs-sync';

export type Locale = 'en' | 'zh';

export interface LocaleMeta {
  /** BCP-47-ish code used as the locale id + persisted value + <html lang>. */
  code: Locale;
  /** English label (for code/AI-facing contexts). */
  label: string;
  /** Endonym shown to the user in the language picker. */
  nativeLabel: string;
}

/** Adding a language = append here + drop a sibling JSON in ./locales. */
export const SUPPORTED_LOCALES: readonly LocaleMeta[] = [
  { code: 'en', label: 'English', nativeLabel: 'English' },
  { code: 'zh', label: 'Chinese', nativeLabel: '中文' },
] as const;

export const DEFAULT_LOCALE: Locale = 'en';

type Catalog = Record<string, unknown>;
const CATALOGS: Record<Locale, Catalog> = { en: en as Catalog, zh: zh as Catalog };

// ── store ──────────────────────────────────────────────────────────────────
let current: Locale = DEFAULT_LOCALE;
const listeners = new Set<() => void>();

function broadcastLocaleToPlugins(locale: Locale): void {
  if (typeof window === 'undefined') return;
  const msg = { type: 'forgeax:locale-changed', locale };
  for (const iframe of document.querySelectorAll('iframe')) {
    try {
      iframe.contentWindow?.postMessage(msg, '*');
    } catch {
      /* cross-origin or detached */
    }
  }
}

function emit() {
  broadcastLocaleToPlugins(current);
  for (const fn of listeners) fn();
}

function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && SUPPORTED_LOCALES.some((l) => l.code === v);
}

/** Read the persisted locale (no side effects). Falls back to DEFAULT_LOCALE. */
function readPersisted(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEYS.locale);
    if (isLocale(raw)) return raw;
  } catch {
    /* private mode */
  }
  return DEFAULT_LOCALE;
}

/**
 * Initialize locale from persisted prefs. Call once, early, in main.tsx.
 * Safe to call again (idempotent) — restored prefs sync may re-trigger it.
 */
let storageWired = false;
export function initI18n(): void {
  setLocale(readPersisted(), { persist: false });
  // Cross-document/tab sync: the `storage` event fires in OTHER same-origin
  // documents when localStorage changes. The editor runs same-origin (proxied
  // at /editor/), so switching language in the host live-updates the editor
  // shell (and vice-versa), plus multi-tab stays in sync. Apply with
  // persist:false to avoid a write-loop.
  if (!storageWired && typeof window !== 'undefined') {
    storageWired = true;
    window.addEventListener('storage', (e) => {
      if (!e.key || e.key === STORAGE_KEYS.locale) setLocale(readPersisted(), { persist: false });
    });
  }
}

export function getLocale(): Locale {
  return current;
}

/** Subscribe to host locale changes (same-tab; storage events don't fire locally). */
export function subscribeLocale(listener: (locale: Locale) => void): () => void {
  const wrapped = () => listener(current);
  listeners.add(wrapped);
  return () => listeners.delete(wrapped);
}

export function setLocale(next: Locale, opts: { persist?: boolean } = {}): void {
  const persist = opts.persist ?? true;
  if (!isLocale(next)) return;
  const changed = next !== current;
  current = next;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = next;
  }
  if (persist && typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEYS.locale, next);
      // Same-tab localStorage writes don't fire the `storage` event the prefs
      // sync listens to, so push immediately — otherwise a quick reload would
      // restore a stale server snapshot and revert the language.
      if (changed) void flushBrowserPrefs();
    } catch {
      /* ignore */
    }
  }
  if (changed) emit();
}

/** react-i18next-compatible alias. */
export function changeLanguage(next: Locale): void {
  setLocale(next);
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// ── lookup ───────────────────────────────────────────────────────────────────
function resolve(catalog: Catalog, key: string): string | undefined {
  // Support both flat keys ("settings.title" as a literal property) and nested
  // objects ({ settings: { title } }). Try flat first, then walk the path.
  const flat = catalog[key];
  if (typeof flat === 'string') return flat;
  let node: unknown = catalog;
  for (const part of key.split('.')) {
    if (node && typeof node === 'object' && part in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof node === 'string' ? node : undefined;
}

function interpolate(tpl: string, vars?: Record<string, string | number>): string {
  if (!vars) return tpl;
  // Supports {{name}} (i18next style) and {name} (terse).
  return tpl.replace(/\{\{?\s*(\w+)\s*\}?\}/g, (m, name: string) =>
    name in vars ? String(vars[name]) : m,
  );
}

export type TFunction = (key: string, vars?: Record<string, string | number>) => string;

/** Locale-agnostic translate. Falls back current → en → key. */
export function t(key: string, vars?: Record<string, string | number>): string {
  const hit =
    resolve(CATALOGS[current], key) ??
    (current !== 'en' ? resolve(CATALOGS.en, key) : undefined) ??
    key;
  return interpolate(hit, vars);
}

// ── React binding ────────────────────────────────────────────────────────────
const getSnapshot = () => current;

/** react-i18next-compatible hook. Re-renders the caller on language change. */
export function useTranslation(): {
  t: TFunction;
  i18n: { language: Locale; changeLanguage: (l: Locale) => void };
} {
  const language = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    // bind so callers always read the live `current` at call time
    t: (key, vars) => t(key, vars),
    i18n: { language, changeLanguage },
  };
}
