// viewport-navigation — pure camera gesture policy and pose helpers.
// @forgeax/editor-edit-runtime — UE-style pointer priority / session commit
// policy. No DOM, engine, or Gateway imports so the interaction contract stays
// independently testable.

export type CameraGestureMode = 'orbit' | 'pan' | 'zoom' | 'fly';

export interface PointerGestureModifiers {
  readonly button: number;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
}
/**
 * Resolve the single camera mode owned by one pointerdown.
 *
 * Priority deliberately mirrors the public UE-style contract:
 * RMB Alt = dolly, otherwise fly; MMB = pan; LMB Alt = orbit, with
 * Ctrl/Meta and Shift aliases taking precedence over orbit.
 *
 * Orthographic views (UE axis views) forbid rotation: the fly and orbit
 * gestures degenerate to pan so the axis alignment can never be broken by a
 * pointer gesture (zoom stays zoom — it adjusts the ortho width, not angles).
 * Mapping to 'pan' instead of returning null also keeps Alt+LMB from falling
 * through to entity picking.
 */
export function cameraGestureForPointer(
  input: PointerGestureModifiers,
  projection: 'perspective' | 'orthographic' = 'perspective',
): CameraGestureMode | null {
  const alt = input.altKey === true;
  const ctrlOrMeta = input.ctrlKey === true || input.metaKey === true;
  const shift = input.shiftKey === true;
  const ortho = projection === 'orthographic';

  if (input.button === 2) return alt ? 'zoom' : ortho ? 'pan' : 'fly';
  if (input.button === 1) return 'pan';
  if (input.button === 0 && alt) {
    if (ctrlOrMeta) return 'zoom';
    if (shift) return 'pan';
    return ortho ? 'pan' : 'orbit';
  }
  return null;
}

export interface CameraPoseSnapshot {
  readonly target: readonly [number, number, number];
  readonly yaw: number;
  readonly pitch: number;
  readonly dist: number;
  readonly camPos: readonly [number, number, number];
  readonly projection: 'perspective' | 'orthographic';
  readonly fov: number;
  readonly orthoHalfHeight: number;
}

function changed(a: number, b: number, epsilon: number): boolean {
  return Math.abs(a - b) > epsilon;
}

/**
 * Return whether a navigation gesture changed the visible camera pose.
 *
 * The epsilon prevents a click-without-motion from creating an empty session
 * ledger entry while still treating normal pointer deltas as meaningful.
 */
export function cameraPoseChanged(
  before: CameraPoseSnapshot,
  after: CameraPoseSnapshot,
  epsilon = 1e-6,
): boolean {
  if (before.projection !== after.projection) return true;
  if (changed(before.yaw, after.yaw, epsilon)
    || changed(before.pitch, after.pitch, epsilon)
    || changed(before.dist, after.dist, epsilon)
    || changed(before.fov, after.fov, epsilon)
    || changed(before.orthoHalfHeight, after.orthoHalfHeight, epsilon)) return true;

  for (let i = 0; i < 3; i++) {
    if (changed(before.target[i]!, after.target[i]!, epsilon)
      || changed(before.camPos[i]!, after.camPos[i]!, epsilon)) return true;
  }
  return false;
}

/**
 * Pointer-lock events expose movement deltas; pointer-capture fallback only
 * exposes client coordinates. Keeping the conversion pure makes both paths
 * deterministic in browser and unit tests.
 */
export function pointerMovementDelta(
  event: { readonly clientX: number; readonly clientY: number; readonly movementX?: number; readonly movementY?: number },
  previous: readonly [number, number],
  pointerLocked: boolean,
): [number, number] {
  if (pointerLocked) {
    return [event.movementX ?? 0, event.movementY ?? 0];
  }
  return [event.clientX - previous[0], event.clientY - previous[1]];
}
