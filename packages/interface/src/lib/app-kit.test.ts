/**
 * app-kit.ts contract tests.
 *
 * Covers the three named exports of the AppKit SDK:
 *   - defineApp(spec) -> { manifest: spec } (P0 placeholder, returns spec as-is)
 *   - mountComposition(opts) -> throws AppKitError when entryUrl missing
 *   - AppKitError class extends Error with code / hint / expected fields
 *
 * The former standalone iframe-mount entry + its specs were deep-removed in
 * M3 (requirements AC-09 / plan-strategy §7 M3): the standalone editor host
 * collapsed onto a single realm and mounts via React createRoot, so that
 * mount point carried no live consumer.
 *
 * Charter P3: AI users consume the error via property access (err.code,
 * err.hint, err.expected), not via parsing err.message.
 */
import { describe, it, expect } from 'bun:test';
import {
  defineApp,
  mountComposition,
  AppKitError,
} from '../app-kit';

describe('defineApp', () => {
  it('returns an object whose manifest is the input spec (P0 placeholder)', () => {
    const spec = {
      id: 'editor',
      entryUrl: 'http://127.0.0.1:15280/?viewportOnly=1',
      panels: [{ id: 'hierarchy' }],
      surfaces: [],
      routes: [],
    };
    const app = defineApp(spec);
    expect(app).toBeDefined();
    expect(app.manifest).toBe(spec);
    expect(app.manifest.id).toBe('editor');
    expect(app.manifest.panels).toHaveLength(1);
  });
});

describe('AppKitError', () => {
  it('is an Error subclass exposing code / hint / expected as own properties', () => {
    const err = new AppKitError({
      code: 'MISSING_ENTRY_URL',
      hint: 'Provide entryUrl in mountComposition({ entryUrl })',
      expected: 'string url',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppKitError);
    expect(err.code).toBe('MISSING_ENTRY_URL');
    expect(err.hint).toBe('Provide entryUrl in mountComposition({ entryUrl })');
    expect(err.expected).toBe('string url');
    expect(typeof err.message).toBe('string');
    expect(err.message.length).toBeGreaterThan(0);
  });
});

describe('mountComposition', () => {
  it('is a function', () => {
    expect(typeof mountComposition).toBe('function');
  });

  it('throws AppKitError MISSING_ENTRY_URL when opts.entryUrl is absent', () => {
    let caught: unknown = null;
    try {
      mountComposition({} as Parameters<typeof mountComposition>[0]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppKitError);
    const err = caught as AppKitError;
    expect(err.code).toBe('MISSING_ENTRY_URL');
    expect(typeof err.hint).toBe('string');
    expect(err.hint.length).toBeGreaterThan(0);
    expect(err.expected).toBeDefined();
  });

  it('does not throw when opts.entryUrl is provided', () => {
    expect(() =>
      mountComposition({ entryUrl: 'http://127.0.0.1:15280/' }),
    ).not.toThrow();
  });
});
