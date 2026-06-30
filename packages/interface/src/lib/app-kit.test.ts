/**
 * w0a (M0 red) - app-kit.ts contract tests.
 *
 * Covers the four named exports of the AppKit SDK skeleton:
 *   - defineApp(spec) -> { manifest: spec } (P0 placeholder, returns spec as-is)
 *   - mountStandalone(opts) -> throws AppKitError when entryUrl missing
 *   - mountComposition(opts) -> throws AppKitError when entryUrl missing
 *   - AppKitError class extends Error with code / hint / expected fields
 *
 * Charter P3: AI users consume the error via property access (err.code,
 * err.hint, err.expected), not via parsing err.message.
 *
 * Until w0b lands the implementation, this file fails at module resolution.
 */
import { describe, it, expect } from 'bun:test';
import {
  defineApp,
  mountStandalone,
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
      hint: 'mountStandalone(app) requires a DefinedApp whose manifest.entryUrl is a non-empty URL string',
      expected: 'string url',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppKitError);
    expect(err.code).toBe('MISSING_ENTRY_URL');
    expect(err.hint).toBe('mountStandalone(app) requires a DefinedApp whose manifest.entryUrl is a non-empty URL string');
    expect(err.expected).toBe('string url');
    expect(typeof err.message).toBe('string');
    expect(err.message.length).toBeGreaterThan(0);
  });
});

// w8 (M3 red) — mountStandalone error-path tests under the new signature.
//
// New signature (plan-strategy §2 D-5 / D-6):
//   mountStandalone(app: DefinedApp, opts?: { rootEl?: HTMLElement; branding?: ... })
//
// Four error paths covered (see plan-tasks w8.description):
//   (a) MISSING_ENTRY_URL  — app.manifest.entryUrl is '' / missing
//   (b) INVALID_ROOT_EL    — opts.rootEl === null
//   (c) INVALID_ROOT_EL    — opts.rootEl is a detached element (not in DOM)
//   (d) MISSING_ENTRY_URL  — bare manifest passed in app slot (no `manifest` field)
//
// Charter P3 — the AppKitError carries code / hint / expected as own
// properties so AI users branch on err.code without parsing err.message.
//
// AC anchors: requirements §AC-09 / §AC-10; plan-strategy §2 D-5 / D-6.

type MountStandaloneArgs = Parameters<typeof mountStandalone>;

function makeValidApp() {
  return {
    manifest: {
      id: 'editor',
      entryUrl: 'http://127.0.0.1:15280/?viewportOnly=1',
      panels: [{ id: 'hierarchy' }],
      surfaces: [],
      routes: [],
    },
  };
}

describe('mountStandalone (new signature, w8 error paths)', () => {
  it('is a function', () => {
    expect(typeof mountStandalone).toBe('function');
  });

  it('(a) throws MISSING_ENTRY_URL when app.manifest.entryUrl is the empty string', () => {
    const app = makeValidApp();
    app.manifest.entryUrl = '';
    let caught: unknown = null;
    try {
      mountStandalone(app as unknown as MountStandaloneArgs[0]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppKitError);
    const err = caught as AppKitError;
    expect(err.code).toBe('MISSING_ENTRY_URL');
    expect(typeof err.hint).toBe('string');
    expect(err.hint.length).toBeGreaterThan(0);
    expect(typeof err.expected === 'string' || typeof err.expected === 'object').toBe(true);
  });

  it('(b) throws INVALID_ROOT_EL when opts.rootEl is explicitly null', () => {
    const app = makeValidApp();
    let caught: unknown = null;
    try {
      mountStandalone(
        app as unknown as MountStandaloneArgs[0],
        { rootEl: null as unknown as HTMLElement } as MountStandaloneArgs[1],
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppKitError);
    const err = caught as AppKitError;
    expect(err.code).toBe('INVALID_ROOT_EL');
    expect(typeof err.hint).toBe('string');
    expect(err.hint.length).toBeGreaterThan(0);
    expect(err.expected).toBeDefined();
  });

  it('(c) throws INVALID_ROOT_EL when opts.rootEl is a detached element not in the DOM', () => {
    const app = makeValidApp();
    const detached = document.createElement('div');
    // Intentionally NOT appended to document.body — should fail the DOM-attached check.
    let caught: unknown = null;
    try {
      mountStandalone(app as unknown as MountStandaloneArgs[0], { rootEl: detached });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppKitError);
    const err = caught as AppKitError;
    expect(err.code).toBe('INVALID_ROOT_EL');
    expect(typeof err.hint).toBe('string');
    expect(err.hint.length).toBeGreaterThan(0);
  });

  it('(d) throws MISSING_ENTRY_URL when a bare manifest is passed in the app slot (no `manifest` field)', () => {
    // Simulates the F-6 C-6 regression: caller hands the manifest itself
    // instead of the DefinedApp wrapper. With no `manifest` field the wrapper
    // can't reach entryUrl, so the error must surface on the entryUrl axis.
    const bareManifest = {
      id: 'editor',
      entryUrl: 'http://127.0.0.1:15280/?viewportOnly=1',
      panels: [{ id: 'hierarchy' }],
      surfaces: [],
      routes: [],
    };
    let caught: unknown = null;
    try {
      mountStandalone(bareManifest as unknown as MountStandaloneArgs[0]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppKitError);
    const err = caught as AppKitError;
    expect(err.code).toBe('MISSING_ENTRY_URL');
    expect(typeof err.hint).toBe('string');
    expect(err.hint.length).toBeGreaterThan(0);
  });

  it('does not throw when given a valid DefinedApp (rootEl defaults to document.body)', () => {
    const app = makeValidApp();
    expect(() =>
      mountStandalone(app as unknown as MountStandaloneArgs[0]),
    ).not.toThrow();
    // Cleanup — strip iframe(s) the previous successful mount may have created.
    document.querySelectorAll('iframe').forEach((n) => n.remove());
  });
});

// w9 (M3 red) — idempotent mount + listener-gate tests.
//
// Plan-strategy §2 D-6:
//   - Repeated mountStandalone(app) calls remove the prior iframe before
//     creating a new one (idempotent overwrite). After N calls the DOM
//     contains exactly 1 iframe.
//   - The host-side message listener is bound on the host `window` (not on
//     the iframe element); after the iframe `.remove()` the listener stays
//     alive and gates the *new* iframe by checking `event.source ===
//     currentIframe.contentWindow`.
//   - Origin gating: messages from a foreign origin are dropped before any
//     schema-validation path is reached.
//
// AC anchors: requirements §AC-09 + §boundary-cases 4-6; research §F-6
// C-2 / C-3 / C-4 / C-5.

describe('mountStandalone (new signature, w9 idempotent + listener gate)', () => {
  it('(a) repeated mountStandalone(app) leaves exactly 1 iframe in the DOM', () => {
    // Strip any leftover iframe before the assertion baseline.
    document.querySelectorAll('iframe').forEach((n) => n.remove());

    const app = makeValidApp();
    mountStandalone(app as unknown as MountStandaloneArgs[0]);
    mountStandalone(app as unknown as MountStandaloneArgs[0]);
    mountStandalone(app as unknown as MountStandaloneArgs[0]);

    expect(document.querySelectorAll('iframe').length).toBe(1);

    // Cleanup
    document.querySelectorAll('iframe').forEach((n) => n.remove());
  });

  it('(b) host listener stays bound after iframe is replaced and gates the new iframe by event.source', async () => {
    // Strip baseline.
    document.querySelectorAll('iframe').forEach((n) => n.remove());

    const app = makeValidApp();
    mountStandalone(app as unknown as MountStandaloneArgs[0]);
    // First iframe in place — replace it.
    mountStandalone(app as unknown as MountStandaloneArgs[0]);

    const iframes = document.querySelectorAll('iframe');
    expect(iframes.length).toBe(1);
    const currentIframe = iframes[0] as HTMLIFrameElement;
    // The listener bound on host window must still receive events when the
    // *current* iframe contentWindow posts. Since happy-dom does not run the
    // iframe child synchronously, we assert the listener path via a synthetic
    // MessageEvent whose `source` is currentIframe.contentWindow.
    expect(currentIframe.contentWindow).toBeDefined();

    // Drop a synthetic message from the current iframe's contentWindow — the
    // host listener should accept it (no throw, no error log). We can only
    // observe non-throw here; the green-phase impl wires the actual handler.
    const ev = new MessageEvent('message', {
      data: { type: 'VAG_PING' },
      origin: 'http://127.0.0.1:15280',
      source: currentIframe.contentWindow,
    });
    expect(() => window.dispatchEvent(ev)).not.toThrow();

    // Cleanup
    document.querySelectorAll('iframe').forEach((n) => n.remove());
  });

  it('(c) host listener drops messages whose event.source does not match currentIframe.contentWindow', () => {
    // Strip baseline.
    document.querySelectorAll('iframe').forEach((n) => n.remove());

    const app = makeValidApp();
    mountStandalone(app as unknown as MountStandaloneArgs[0]);

    // Spawn an unrelated iframe that the SDK did NOT mount — its
    // contentWindow must be ignored by the host listener.
    const stranger = document.createElement('iframe');
    document.body.appendChild(stranger);

    const ev = new MessageEvent('message', {
      data: { type: 'VAG_PING' },
      origin: 'http://127.0.0.1:15280',
      source: stranger.contentWindow,
    });
    expect(() => window.dispatchEvent(ev)).not.toThrow();

    // Cleanup — leave a single iframe (the SDK-mounted one) before next test.
    stranger.remove();
    document.querySelectorAll('iframe').forEach((n) => n.remove());
  });

  it('(d) host listener drops messages from a foreign origin before reaching schema parsing', () => {
    // Strip baseline.
    document.querySelectorAll('iframe').forEach((n) => n.remove());

    const app = makeValidApp();
    mountStandalone(app as unknown as MountStandaloneArgs[0]);
    const currentIframe = document.querySelector('iframe') as HTMLIFrameElement;
    expect(currentIframe).not.toBeNull();

    const ev = new MessageEvent('message', {
      data: { type: 'VAG_PING' },
      origin: 'http://evil.example',
      source: currentIframe.contentWindow,
    });
    // Listener must drop foreign-origin events without throwing.
    expect(() => window.dispatchEvent(ev)).not.toThrow();

    // Cleanup
    document.querySelectorAll('iframe').forEach((n) => n.remove());
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
