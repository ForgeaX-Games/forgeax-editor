import { describe, expect, test } from 'bun:test';
import {
  interpretLiveCatalogProbe,
  needsConnectSelection,
  validateApiKeyFields,
} from './connect-selection';

describe('needsConnectSelection', () => {
  test('null → need selection', () => {
    expect(needsConnectSelection(null)).toBe(true);
  });
  test('key/cli → selected', () => {
    expect(needsConnectSelection('key')).toBe(false);
    expect(needsConnectSelection('cli')).toBe(false);
  });
});

describe('validateApiKeyFields', () => {
  test('both non-empty → ok', () => {
    expect(validateApiKeyFields('https://api.openai.com/v1', 'sk-x')).toBe('ok');
  });
  test('whitespace-only counts as empty', () => {
    expect(validateApiKeyFields('  ', 'sk-x')).toBe('empty');
    expect(validateApiKeyFields('https://x', '  ')).toBe('empty');
    expect(validateApiKeyFields('', '')).toBe('empty');
  });
});

describe('interpretLiveCatalogProbe', () => {
  test('live/cache → ok', () => {
    expect(interpretLiveCatalogProbe({ source: 'live' })).toEqual({ ok: true });
    expect(interpretLiveCatalogProbe({ source: 'cache' })).toEqual({ ok: true });
  });
  test('disk fallback / error / disabled → fail', () => {
    expect(interpretLiveCatalogProbe({ source: 'error', error: 'HTTP 401' })).toEqual({
      ok: false,
      error: 'HTTP 401',
    });
    expect(interpretLiveCatalogProbe({ source: 'disabled' })).toEqual({ ok: false, error: undefined });
    // Missing live metadata must not pass (would reintroduce disk-fallback false positives).
    expect(interpretLiveCatalogProbe(undefined)).toEqual({ ok: false, error: undefined });
    expect(interpretLiveCatalogProbe({ source: 'skipped' })).toEqual({ ok: false, error: undefined });
  });
});
