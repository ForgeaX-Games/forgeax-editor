import { describe, expect, test } from 'bun:test';
import { isLedgerBlob } from './ledger-blob';

const valid = {
  __ledger_blob__: true,
  sha256: 'd81f3a3be86b31ef',
  enc: 'utf8',
  len: 72_501,
} as const;

describe('ledger blob wire contract', () => {
  test('accepts strict utf8 and base64 sentinels', () => {
    expect(isLedgerBlob(valid)).toBe(true);
    expect(isLedgerBlob({ ...valid, enc: 'base64' })).toBe(true);
  });

  test('rejects sentinel-shaped values outside the contract', () => {
    expect(isLedgerBlob({ ...valid, sha256: 'not-a-hash' })).toBe(false);
    expect(isLedgerBlob({ ...valid, enc: 'binary' })).toBe(false);
    expect(isLedgerBlob({ ...valid, len: 0 })).toBe(false);
    expect(isLedgerBlob({ ...valid, len: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isLedgerBlob({ ...valid, extra: true })).toBe(false);
    expect(isLedgerBlob(null)).toBe(false);
  });
});
