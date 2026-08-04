export const LEDGER_BLOB_KEY = '__ledger_blob__';

export interface LedgerBlob {
  readonly __ledger_blob__: true;
  readonly sha256: string;
  readonly enc: 'base64' | 'utf8';
  readonly len: number;
}

/** Strict wire-contract guard. Sentinel-shaped external data must not be trusted. */
export function isLedgerBlob(value: unknown): value is LedgerBlob {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (candidate[LEDGER_BLOB_KEY] !== true) return false;
  if (typeof candidate.sha256 !== 'string' || !/^[a-f0-9]{16}$/.test(candidate.sha256)) return false;
  if (candidate.enc !== 'base64' && candidate.enc !== 'utf8') return false;
  if (typeof candidate.len !== 'number' || !Number.isFinite(candidate.len) || candidate.len <= 0 || candidate.len > 1e9) return false;
  return Object.keys(candidate).length === 4;
}
