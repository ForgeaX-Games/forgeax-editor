/**
 * Editor i18n core — the same zero-dependency, react-i18next-shaped core the
 * Studio interface uses (useTranslation/t/changeLanguage, {{var}} interpolation),
 * living in @forgeax/editor-core so editor-panels + edit-runtime can localize.
 *
 * English is the source of truth (`locales/en.json`); `zh.json` is the overlay.
 * The locale is read from the SAME localStorage key the interface uses
 * (`forgeax.locale`) so the editor shell (vendored interface) and the editor
 * panels stay on one language. Because the interface shell and the panels live
 * in the same frame (the editor at :15280), we sync live via:
 *   - a `forgeax:locale-changed` window CustomEvent (same-frame; the interface
 *     core dispatches it on setLocale), and
 *   - the `storage` event (other tabs/frames).
 */

import { useSyncExternalStore } from 'react';
import en from './locales/en.json';
import zh from './locales/zh.json';

export type Locale = 'en' | 'zh';
export const LOCALE_STORAGE_KEY = 'forgeax.locale';
export const LOCALE_CHANGED_EVENT = 'forgeax:locale-changed';

export interface LocaleMeta { code: Locale; label: string; nativeLabel: string }
export const SUPPORTED_LOCALES: readonly LocaleMeta[] = [
  { code: 'en', label: 'English', nativeLabel: 'English' },
  { code: 'zh', label: 'Chinese', nativeLabel: '中文' },
] as const;
export const DEFAULT_LOCALE: Locale = 'en';

type Catalog = Record<string, unknown>;
const CATALOGS: Record<Locale, Catalog> = { en: en as Catalog, zh: zh as Catalog };

function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && SUPPORTED_LOCALES.some((l) => l.code === v);
}

function readPersisted(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;
  try {
    const raw = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(raw)) return raw;
  } catch { /* private mode */ }
  return DEFAULT_LOCALE;
}

let current: Locale = readPersisted();
const listeners = new Set<() => void>();
function emit() { for (const fn of listeners) fn(); }

/** Re-read the persisted locale and notify subscribers if it changed. */
function refresh(): void {
  const next = readPersisted();
  if (next !== current) { current = next; emit(); }
}

let wired = false;
function ensureWired(): void {
  if (wired || typeof window === 'undefined') return;
  wired = true;
  window.addEventListener('storage', (e) => { if (!e.key || e.key === LOCALE_STORAGE_KEY) refresh(); });
  window.addEventListener(LOCALE_CHANGED_EVENT, refresh as EventListener);
}
ensureWired();

export function getLocale(): Locale { return current; }

export function setLocale(next: Locale): void {
  if (!isLocale(next) || next === current) return;
  current = next;
  if (typeof window !== 'undefined') {
    try { window.localStorage.setItem(LOCALE_STORAGE_KEY, next); } catch { /* ignore */ }
    try { window.dispatchEvent(new CustomEvent(LOCALE_CHANGED_EVENT)); } catch { /* ignore */ }
    if (typeof document !== 'undefined') document.documentElement.lang = next;
  }
  emit();
}
export function changeLanguage(next: Locale): void { setLocale(next); }
export function subscribe(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }

function resolve(catalog: Catalog, key: string): string | undefined {
  const flat = catalog[key];
  if (typeof flat === 'string') return flat;
  let node: unknown = catalog;
  for (const part of key.split('.')) {
    if (node && typeof node === 'object' && part in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[part];
    } else return undefined;
  }
  return typeof node === 'string' ? node : undefined;
}

function interpolate(tpl: string, vars?: Record<string, string | number>): string {
  if (!vars) return tpl;
  return tpl.replace(/\{\{?\s*(\w+)\s*\}?\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

export type TFunction = (key: string, vars?: Record<string, string | number>) => string;

export function t(key: string, vars?: Record<string, string | number>): string {
  const hit = resolve(CATALOGS[current], key)
    ?? (current !== 'en' ? resolve(CATALOGS.en, key) : undefined)
    ?? key;
  return interpolate(hit, vars);
}

const getSnapshot = () => current;
export function useTranslation(): { t: TFunction; i18n: { language: Locale; changeLanguage: (l: Locale) => void } } {
  const language = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  // Return the module-level `t` (stable identity). It already reads `current`
  // at call time, so a new closure per render is unnecessary and breaks any
  // useEffect/useMemo that lists `t` as a dependency (infinite re-render loops).
  return { t, i18n: { language, changeLanguage } };
}
