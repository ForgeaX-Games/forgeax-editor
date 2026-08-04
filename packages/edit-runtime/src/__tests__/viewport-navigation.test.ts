import { describe, expect, it } from 'bun:test';
import {
  cameraGestureForPointer,
  cameraPoseChanged,
  pointerMovementDelta,
  type CameraPoseSnapshot,
} from '../viewport/viewport-navigation';

const pose = (overrides: Partial<CameraPoseSnapshot> = {}): CameraPoseSnapshot => ({
  target: [0, 0, 0],
  yaw: 0,
  pitch: 0,
  dist: 10,
  camPos: [0, 0, 10],
  projection: 'perspective',
  fov: Math.PI / 3,
  orthoHalfHeight: 10,
  ...overrides,
});
describe('cameraGestureForPointer', () => {
  it('uses UE-style right-button priority', () => {
    expect(cameraGestureForPointer({ button: 2 })).toBe('fly');
    expect(cameraGestureForPointer({ button: 2, altKey: true })).toBe('zoom');
  });

  it('maps middle-button and Alt-left-button gestures', () => {
    expect(cameraGestureForPointer({ button: 1 })).toBe('pan');
    expect(cameraGestureForPointer({ button: 0, altKey: true })).toBe('orbit');
    expect(cameraGestureForPointer({ button: 0, altKey: true, shiftKey: true })).toBe('pan');
    expect(cameraGestureForPointer({ button: 0, altKey: true, ctrlKey: true })).toBe('zoom');
    expect(cameraGestureForPointer({ button: 0, altKey: true, metaKey: true })).toBe('zoom');
  });

  it('does not steal plain left click selection or unknown buttons', () => {
    expect(cameraGestureForPointer({ button: 0 })).toBeNull();
    expect(cameraGestureForPointer({ button: 3 })).toBeNull();
  });
});
describe('cameraPoseChanged', () => {
  it('does not record a click with no visible pose change', () => {
    expect(cameraPoseChanged(pose(), pose())).toBe(false);
  });

  it('detects orientation, projection, target, and framing changes', () => {
    expect(cameraPoseChanged(pose(), pose({ yaw: 0.01 }))).toBe(true);
    expect(cameraPoseChanged(pose(), pose({ projection: 'orthographic' }))).toBe(true);
    expect(cameraPoseChanged(pose(), pose({ target: [1, 0, 0] }))).toBe(true);
    expect(cameraPoseChanged(pose(), pose({ orthoHalfHeight: 9 }))).toBe(true);
  });

  it('supports an explicit epsilon for pointer noise', () => {
    expect(cameraPoseChanged(pose(), pose({ yaw: 0.00001 }), 0.001)).toBe(false);
    expect(cameraPoseChanged(pose(), pose({ yaw: 0.01 }), 0.001)).toBe(true);
  });
});

describe('pointerMovementDelta', () => {
  it('uses movement deltas under pointer lock', () => {
    expect(pointerMovementDelta({ clientX: 100, clientY: 100, movementX: 7, movementY: -3 }, [4, 8], true))
      .toEqual([7, -3]);
  });

  it('uses client deltas for pointer-capture fallback', () => {
    expect(pointerMovementDelta({ clientX: 100, clientY: 100, movementX: 7, movementY: -3 }, [4, 8], false))
      .toEqual([96, 92]);
  });
});
