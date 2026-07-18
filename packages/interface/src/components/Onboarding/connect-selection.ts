export type ConnectPath = 'key' | 'cli';
export type ConnectSelected = ConnectPath | null;

/** True when Next must block — user has not picked API Key or local CLI yet.
 *  (Skip still advances without a selection.) */
export function needsConnectSelection(selected: ConnectSelected): boolean {
  return selected === null;
}

export function validateApiKeyFields(baseUrl: string, apiKey: string): 'ok' | 'empty' {
  if (!baseUrl.trim() || !apiKey.trim()) return 'empty';
  return 'ok';
}

/** Live `/v1/models` probe result from `list_models` (server merges disk+live).
 *  Disk fallback must NOT count as connected — only a real live/cache hit. */
export function interpretLiveCatalogProbe(live: {
  source?: string;
  error?: string;
} | null | undefined): { ok: true } | { ok: false; error?: string } {
  const source = live?.source;
  if (source === 'live' || source === 'cache') return { ok: true };
  return { ok: false, error: live?.error };
}
