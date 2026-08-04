// Viewport preferences — editor chrome state only.
//
// The value is deliberately stored outside the editor document: it must not
// enter scene packs, the authored Play world, document undo, or the Gateway
// ledger. The `forgeax.*` key is also covered by the interface browser-prefs
// mirror when the editor is hosted by the full application.

import {
  clampDist,
  clampFov,
  clampFlySpeed,
  clampOrthoHalfHeight,
  clampPitch,
  FLY_BOOST_MULTIPLIER,
  FLY_SPEED_DEFAULT,
  FLY_SPEED_MAX,
  FLY_SPEED_MIN,
  FOV_DEFAULT,
  ORTHO_HALF_HEIGHT_DEFAULT,
  type CameraProjection,
} from './viewport-camera';
import type { CameraBookmark } from './viewport-camera-appliers';

export const VIEWPORT_PREFERENCES_STORAGE_KEY = 'forgeax.viewport.preferences.v1';

/** Minimal storage seam so persistence is testable without a browser DOM. */
export interface ViewportPreferencesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type CameraBookmarkSlot = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export interface ViewportPreferences {
  /** Mouse delta multiplier for orbit, pan, dolly, and fly look. */
  mouseSensitivity: number;
  /** Reverse vertical mouse look for users who prefer inverted Y. */
  invertY: boolean;
  /** Multiplier for wheel direction; 1 is the default editor convention. */
  wheelDirection: 1 | -1;
  /** Flight speed retained after the user changes it with the wheel. */
  flySpeed: number;
  /** Number of wheel-speed steps applied per wheel notch while flying. */
  wheelSpeedScalar: number;
  /** Temporary Shift-held flight multiplier. */
  flyBoostMultiplier: number;
  /** Last editor viewport projection, independent from authored Camera entities. */
  projection: CameraProjection;
  /** Last perspective view scale. */
  fov: number;
  /** Last orthographic view scale; null means derive it from the initial orbit. */
  orthoHalfHeight: number | null;
  /** Complete editor-camera poses, keyed by the 1–9 bookmark slot. */
  bookmarks: Partial<Record<CameraBookmarkSlot, CameraBookmark>>;
}

const MOUSE_SENSITIVITY_MIN = 0.05;
const MOUSE_SENSITIVITY_MAX = 5;
const WHEEL_SPEED_SCALAR_MIN = 0.1;
const WHEEL_SPEED_SCALAR_MAX = 4;
const BOOST_MULTIPLIER_MIN = 1;
const BOOST_MULTIPLIER_MAX = 8;

interface PersistedViewportPreferences extends Omit<ViewportPreferences, 'bookmarks'> {
  v: 1;
  bookmarks: Record<string, unknown>;
}

function browserStorage(): ViewportPreferencesStorage | undefined {
  if (typeof globalThis === 'undefined') return undefined;
  try {
    const storage = (globalThis as typeof globalThis & {
      localStorage?: ViewportPreferencesStorage;
    }).localStorage;
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
      return undefined;
    }
    return storage;
  } catch {
    // Private browsing and restricted WebViews can throw while resolving the
    // storage object. The viewport remains usable with in-memory defaults.
    return undefined;
  }
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, finiteOr(value, fallback)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteVec3(value: unknown): value is [number, number, number] {
  return Array.isArray(value)
    && value.length === 3
    && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseBookmark(value: unknown): CameraBookmark | null {
  if (!isRecord(value)
    || !isFiniteVec3(value.target)
    || !isFiniteNumber(value.yaw)
    || !isFiniteNumber(value.pitch)
    || !isFiniteNumber(value.dist)
    || !isFiniteVec3(value.camPos)
    || !isFiniteVec3(value.fwd)
    || !isFiniteVec3(value.rgt)
    || !isFiniteVec3(value.upv)
    || (value.projection !== 'perspective' && value.projection !== 'orthographic')
    || !isFiniteNumber(value.fov)
    || !isFiniteNumber(value.orthoHalfHeight)) {
    return null;
  }
  return {
    target: [...value.target],
    yaw: value.yaw,
    pitch: clampPitch(value.pitch),
    dist: clampDist(value.dist),
    camPos: [...value.camPos],
    fwd: [...value.fwd],
    rgt: [...value.rgt],
    upv: [...value.upv],
    projection: value.projection,
    fov: clampFov(value.fov),
    orthoHalfHeight: clampOrthoHalfHeight(value.orthoHalfHeight),
  };
}

export function defaultViewportPreferences(): ViewportPreferences {
  return {
    mouseSensitivity: 1,
    invertY: false,
    wheelDirection: 1,
    flySpeed: FLY_SPEED_DEFAULT,
    wheelSpeedScalar: 1,
    flyBoostMultiplier: FLY_BOOST_MULTIPLIER,
    projection: 'perspective',
    fov: FOV_DEFAULT,
    orthoHalfHeight: null,
    bookmarks: {},
  };
}

/** Normalize persisted data so malformed or old browser values fail closed. */
export function normalizeViewportPreferences(value: unknown): ViewportPreferences {
  const defaults = defaultViewportPreferences();
  if (!isRecord(value)) return defaults;

  const preferences: ViewportPreferences = {
    mouseSensitivity: clamp(
      value.mouseSensitivity,
      defaults.mouseSensitivity,
      MOUSE_SENSITIVITY_MIN,
      MOUSE_SENSITIVITY_MAX,
    ),
    invertY: typeof value.invertY === 'boolean' ? value.invertY : defaults.invertY,
    wheelDirection: value.wheelDirection === -1 ? -1 : 1,
    flySpeed: clamp(value.flySpeed, defaults.flySpeed, FLY_SPEED_MIN, FLY_SPEED_MAX),
    wheelSpeedScalar: clamp(
      value.wheelSpeedScalar,
      defaults.wheelSpeedScalar,
      WHEEL_SPEED_SCALAR_MIN,
      WHEEL_SPEED_SCALAR_MAX,
    ),
    flyBoostMultiplier: clamp(
      value.flyBoostMultiplier,
      defaults.flyBoostMultiplier,
      BOOST_MULTIPLIER_MIN,
      BOOST_MULTIPLIER_MAX,
    ),
    projection: value.projection === 'orthographic' ? 'orthographic' : 'perspective',
    fov: clampFov(finiteOr(value.fov, defaults.fov)),
    orthoHalfHeight: !Object.prototype.hasOwnProperty.call(value, 'orthoHalfHeight')
      || value.orthoHalfHeight === null
      ? null
      : clampOrthoHalfHeight(finiteOr(value.orthoHalfHeight, ORTHO_HALF_HEIGHT_DEFAULT)),
    bookmarks: {},
  };

  if (isRecord(value.bookmarks)) {
    for (const slot of Object.keys(value.bookmarks)) {
      if (!/^[1-9]$/.test(slot)) continue;
      const bookmark = parseBookmark(value.bookmarks[slot]);
      if (bookmark) {
        preferences.bookmarks[Number(slot) as CameraBookmarkSlot] = bookmark;
      }
    }
  }
  return preferences;
}

/** Load preferences from the injected storage, or the browser localStorage. */
export function loadViewportPreferences(
  storage: ViewportPreferencesStorage | undefined = browserStorage(),
): ViewportPreferences {
  if (!storage) return defaultViewportPreferences();
  try {
    const raw = storage.getItem(VIEWPORT_PREFERENCES_STORAGE_KEY);
    if (!raw) return defaultViewportPreferences();
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.v !== 1) return defaultViewportPreferences();
    return normalizeViewportPreferences(parsed);
  } catch {
    return defaultViewportPreferences();
  }
}

/**
 * Save a normalized snapshot. Returning false is intentional: persistence is
 * best-effort editor chrome and must never make camera navigation fail.
 */
export function saveViewportPreferences(
  preferences: ViewportPreferences,
  storage: ViewportPreferencesStorage | undefined = browserStorage(),
): boolean {
  if (!storage) return false;
  try {
    const normalized = normalizeViewportPreferences(preferences);
    const persisted: PersistedViewportPreferences = {
      v: 1,
      ...normalized,
      bookmarks: normalized.bookmarks as Record<string, unknown>,
    };
    storage.setItem(VIEWPORT_PREFERENCES_STORAGE_KEY, JSON.stringify(persisted));
    return true;
  } catch {
    return false;
  }
}
