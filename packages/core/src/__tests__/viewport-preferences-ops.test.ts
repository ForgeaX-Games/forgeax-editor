// viewport-preferences-ops — session-domain routing for setViewportPreferences.
//
// Viewport interaction preferences are editor chrome session state: ledger-only
// (no undo), human (viewport settings menu / Settings dock panel) and AI
// dispatch the SAME op (north-star single door), numeric patches clamp
// fail-closed instead of rejecting, malformed patches fail fast with
// INVALID_ARGS, and the store persists to storage on every accepted patch.

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { EditGateway } from '../io/gateway';
import type { EditorOp, EditSession } from '../types';
import { createEditSession } from '../session/document';
import {
  defaultViewportPreferences,
  getViewportPreferences,
  onViewportPreferencesChange,
  VIEWPORT_PREFERENCES_STORAGE_KEY,
  type ViewportPreferencesPatch,
  type ViewportPreferencesStorage,
} from '../store/viewport-preferences';
import { FOV_MAX, FLY_SPEED_MIN } from '../store/viewport-camera-limits';

function createSession(): EditSession {
  const session = createEditSession();
  session.world = new World();
  return session;
}

function patchOp(patch: ViewportPreferencesPatch): EditorOp {
  return { kind: 'setViewportPreferences', patch } as EditorOp;
}

class MemoryStorage implements ViewportPreferencesStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('session routing — setViewportPreferences', () => {
  let gw: EditGateway;
  let storage: MemoryStorage;
  const globalScope = globalThis as Omit<typeof globalThis, 'localStorage'> & { localStorage?: ViewportPreferencesStorage };
  // bun test shares one process across files and sibling suites may install an
  // ambient READ-ONLY localStorage (resize-handle.test.ts), so the shim must
  // go through defineProperty and restore the previous descriptor afterwards.
  const ambientDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

  beforeEach(() => {
    gw = new EditGateway(createSession());
    // The store is module-global — reset to defaults between tests.
    gw.dispatch(patchOp(defaultViewportPreferences()));
    storage = new MemoryStorage();
    Object.defineProperty(globalScope, 'localStorage', { value: storage, configurable: true, writable: true });
  });

  afterEach(() => {
    if (ambientDescriptor) Object.defineProperty(globalScope, 'localStorage', ambientDescriptor);
    else delete globalScope.localStorage;
  });

  it('(a) dispatch applies a partial patch and keeps unmentioned fields', () => {
    const before = getViewportPreferences();
    const r = gw.dispatch(patchOp({ mouseSensitivity: 1.5, invertY: true }));
    expect(r.ok).toBe(true);
    const prefs = getViewportPreferences();
    expect(prefs.mouseSensitivity).toBe(1.5);
    expect(prefs.invertY).toBe(true);
    expect(prefs.flySpeed).toBe(before.flySpeed);
    expect(prefs.projection).toBe(before.projection);
  });

  it('(b) grows the ledger, not the undo history', () => {
    const undoBefore = gw.appliedCount();
    const ledgerBefore = gw.ledger.length;
    gw.dispatch(patchOp({ flySpeed: 24 }));
    expect(gw.ledger.length).toBe(ledgerBefore + 1);
    expect(gw.appliedCount()).toBe(undoBefore);
  });

  it('(c) is AI-dispatchable with a distinguishable origin', () => {
    const r = gw.dispatch(patchOp({ wheelSpeedScalar: 2 }), 'ai');
    expect(r.ok).toBe(true);
    expect(gw.origins[gw.origins.length - 1]).toBe('ai');
    expect(getViewportPreferences().wheelSpeedScalar).toBe(2);
  });

  it('(d) rejects a missing patch with INVALID_ARGS and no ledger residue', () => {
    const before = gw.ledger.length;
    const r = gw.dispatch({ kind: 'setViewportPreferences' } as unknown as EditorOp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_ARGS');
    expect(gw.ledger.length).toBe(before);
  });

  it('(e) rejects wrong-typed patch fields at the gateway schema boundary', () => {
    const r = gw.dispatch({
      kind: 'setViewportPreferences',
      patch: { mouseSensitivity: 'high' },
    } as unknown as EditorOp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_ARGS');
  });

  it('(f) rejects out-of-enum wheelDirection at the gateway schema boundary', () => {
    const r = gw.dispatch({
      kind: 'setViewportPreferences',
      patch: { wheelDirection: 0 },
    } as unknown as EditorOp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_ARGS');
  });

  it('(g) clamps out-of-range numbers fail-closed instead of rejecting', () => {
    const r = gw.dispatch(patchOp({ mouseSensitivity: 99, flySpeed: -100, fov: 99, flyBoostMultiplier: 0 }));
    expect(r.ok).toBe(true);
    const prefs = getViewportPreferences();
    expect(prefs.mouseSensitivity).toBe(5);
    expect(prefs.flySpeed).toBe(FLY_SPEED_MIN);
    expect(prefs.fov).toBe(FOV_MAX);
    expect(prefs.flyBoostMultiplier).toBe(1);
  });

  it('(h) drops unknown patch keys', () => {
    const before = getViewportPreferences();
    const r = gw.dispatch({
      kind: 'setViewportPreferences',
      patch: { nonsense: 1, invertY: true },
    } as unknown as EditorOp);
    expect(r.ok).toBe(true);
    const prefs = getViewportPreferences();
    expect(prefs.invertY).toBe(true);
    expect('nonsense' in prefs).toBe(false);
    expect(prefs.mouseSensitivity).toBe(before.mouseSensitivity);
  });

  it('(i) never overwrites camera bookmarks from the op path', () => {
    const withBookmark = getViewportPreferences();
    withBookmark.bookmarks[3] = {
      target: [0, 1, 0],
      yaw: 0.5,
      pitch: -0.2,
      dist: 10,
      camPos: [1, 2, 3],
      fwd: [0, 0, -1],
      rgt: [1, 0, 0],
      upv: [0, 1, 0],
      projection: 'perspective',
      fov: Math.PI / 3,
      orthoHalfHeight: 4,
    };
    const r = gw.dispatch(patchOp({ projection: 'orthographic' }));
    expect(r.ok).toBe(true);
    expect(getViewportPreferences().bookmarks[3]).toBeDefined();
  });

  it('(j) notifies listeners on an accepted patch', () => {
    let calls = 0;
    const unsub = onViewportPreferencesChange(() => { calls++; });
    gw.dispatch(patchOp({ mouseSensitivity: 2 }));
    unsub();
    expect(calls).toBe(1);
  });

  it('(k) persists the normalized snapshot to storage', () => {
    const r = gw.dispatch(patchOp({ mouseSensitivity: 3 }));
    expect(r.ok).toBe(true);
    const raw = storage.getItem(VIEWPORT_PREFERENCES_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { v: number; mouseSensitivity: number };
    expect(parsed.v).toBe(1);
    expect(parsed.mouseSensitivity).toBe(3);
  });
});
