import { describe, expect, it } from 'bun:test';
import {
  defaultViewportPreferences,
  readViewportPreferences,
  writeViewportPreferences,
  VIEWPORT_PREFERENCES_STORAGE_KEY,
  type CameraBookmark,
  type ViewportPreferencesStorage,
} from '../store/viewport-preferences';

class MemoryStorage implements ViewportPreferencesStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function makeBookmark(): CameraBookmark {
  return {
    target: [0, 1, 0],
    yaw: 0.5,
    pitch: -0.2,
    dist: 10,
    camPos: [1, 2, 3],
    fwd: [0, 0, -1],
    rgt: [1, 0, 0],
    upv: [0, 1, 0],
    projection: 'orthographic',
    fov: Math.PI / 3,
    orthoHalfHeight: 4,
  };
}

describe('viewport preferences persistence', () => {
  it('uses editor-safe defaults without touching authored state', () => {
    const preferences = defaultViewportPreferences();
    expect(preferences.projection).toBe('perspective');
    expect(preferences.activeView).toBe('perspective');
    expect(preferences.flySpeed).toBe(8);
    expect(preferences.orthoHalfHeight).toBeNull();
    expect(preferences.bookmarks).toEqual({});
  });

  it('round-trips the activeView menu identity and rejects unknown values', () => {
    const storage = new MemoryStorage();
    const preferences = defaultViewportPreferences();
    preferences.activeView = 'top';
    expect(writeViewportPreferences(preferences, storage)).toBe(true);
    expect(readViewportPreferences(storage).activeView).toBe('top');

    storage.setItem(VIEWPORT_PREFERENCES_STORAGE_KEY, JSON.stringify({ v: 1, activeView: 'isometric' }));
    expect(readViewportPreferences(storage).activeView).toBe('perspective');
  });

  it('preserves ±90° orthographic bookmark pitch but still clamps perspective bookmarks', () => {
    const storage = new MemoryStorage();
    const preferences = defaultViewportPreferences();
    preferences.bookmarks[1] = { ...makeBookmark(), projection: 'orthographic', pitch: -Math.PI / 2 };
    preferences.bookmarks[2] = { ...makeBookmark(), projection: 'perspective', pitch: -Math.PI / 2 };
    expect(writeViewportPreferences(preferences, storage)).toBe(true);

    const restored = readViewportPreferences(storage);
    // Axis-aligned views (Top/Bottom) legitimately sit at exactly ±90° — the
    // perspective gesture clamp must not corrupt them in persistence.
    expect(restored.bookmarks[1]?.pitch).toBe(-Math.PI / 2);
    expect(restored.bookmarks[2]?.pitch).toBe(-1.5);
  });

  it('round-trips navigation settings and complete camera bookmarks', () => {
    const storage = new MemoryStorage();
    const preferences = defaultViewportPreferences();
    preferences.mouseSensitivity = 1.5;
    preferences.invertY = true;
    preferences.wheelDirection = -1;
    preferences.flySpeed = 24;
    preferences.wheelSpeedScalar = 1.25;
    preferences.flyBoostMultiplier = 3;
    preferences.projection = 'orthographic';
    preferences.fov = Math.PI / 2;
    preferences.orthoHalfHeight = 4;
    preferences.bookmarks[3] = makeBookmark();

    expect(writeViewportPreferences(preferences, storage)).toBe(true);
    expect(storage.getItem(VIEWPORT_PREFERENCES_STORAGE_KEY)).toContain('"v":1');

    const restored = readViewportPreferences(storage);
    expect(restored.mouseSensitivity).toBe(1.5);
    expect(restored.invertY).toBe(true);
    expect(restored.wheelDirection).toBe(-1);
    expect(restored.flySpeed).toBe(24);
    expect(restored.wheelSpeedScalar).toBe(1.25);
    expect(restored.flyBoostMultiplier).toBe(3);
    expect(restored.projection).toBe('orthographic');
    expect(restored.orthoHalfHeight).toBe(4);
    expect(restored.bookmarks[3]).toEqual(makeBookmark());
  });

  it('clamps unsafe values and drops malformed bookmark slots', () => {
    const storage = new MemoryStorage();
    storage.setItem(VIEWPORT_PREFERENCES_STORAGE_KEY, JSON.stringify({
      v: 1,
      mouseSensitivity: Infinity,
      wheelDirection: 0,
      flySpeed: -100,
      wheelSpeedScalar: 100,
      flyBoostMultiplier: 0,
      projection: 'unknown',
      fov: 0,
      orthoHalfHeight: 0,
      bookmarks: {
        1: { ...makeBookmark(), fov: Number.NaN },
        2: makeBookmark(),
        10: makeBookmark(),
      },
    }));

    const restored = readViewportPreferences(storage);
    expect(restored.mouseSensitivity).toBe(1);
    expect(restored.wheelDirection).toBe(1);
    expect(restored.flySpeed).toBe(0.5);
    expect(restored.wheelSpeedScalar).toBe(4);
    expect(restored.flyBoostMultiplier).toBe(1);
    expect(restored.projection).toBe('perspective');
    expect(restored.bookmarks[1]).toBeUndefined();
    expect(restored.bookmarks[2]).toBeDefined();
    expect(Object.keys(restored.bookmarks)).not.toContain('10');
  });

  it('fails closed for corrupt JSON and unavailable storage', () => {
    const storage = new MemoryStorage();
    storage.setItem(VIEWPORT_PREFERENCES_STORAGE_KEY, '{not-json');
    expect(readViewportPreferences(storage)).toEqual(defaultViewportPreferences());
    // bun test shares one process across files and sibling suites may install
    // an ambient localStorage (resize-handle.test.ts), so force the
    // "storage unavailable" branch deterministically via defineProperty.
    const ambient = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true, writable: true });
    try {
      expect(writeViewportPreferences(defaultViewportPreferences(), undefined)).toBe(false);
      expect(readViewportPreferences(undefined)).toEqual(defaultViewportPreferences());
    } finally {
      if (ambient) Object.defineProperty(globalThis, 'localStorage', ambient);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
