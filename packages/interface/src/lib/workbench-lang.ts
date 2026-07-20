import { getLocale, type Locale } from '@/i18n';

/** Current UI locale for `/api/workbench/*` query params. */
export function workbenchLang(): Locale {
  return getLocale();
}

/** Build query string for `/api/workbench/agents` with `lang` aligned to Studio locale. */
export function workbenchAgentsQuery(extra?: Record<string, string | undefined>): string {
  const params = new URLSearchParams({ lang: getLocale() });
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined && v !== '') params.set(k, v);
    }
  }
  return params.toString();
}

/** Build `/api/workbench/agents` with `lang` aligned to Studio locale. */
export function workbenchAgentsUrl(extra?: Record<string, string | undefined>): string {
  return `/api/workbench/agents?${workbenchAgentsQuery(extra)}`;
}

/** Build `/api/workbench/events/recent` with locale-aware agent labels. */
export function workbenchEventsRecentUrl(limit = 30): string {
  return `/api/workbench/events/recent?limit=${limit}&lang=${getLocale()}`;
}
