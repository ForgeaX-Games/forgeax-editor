import { test, expect } from 'bun:test';
import { resolveLanguage } from '../ext-language';

test('resolves a known extension', () => {
  expect(resolveLanguage('ts')).toEqual({ lang: 'typescript', label: 'TypeScript' });
});

test('is case-insensitive and tolerates a leading dot', () => {
  expect(resolveLanguage('.TSX')?.lang).toBe('tsx');
});

test('maps config extensions to a grammar', () => {
  expect(resolveLanguage('json')?.lang).toBe('json');
});

test('returns undefined for an unknown extension', () => {
  expect(resolveLanguage('unknownext')).toBeUndefined();
});
