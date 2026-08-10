import { afterEach, describe, expect, it } from 'bun:test';
import { gateway } from '@forgeax/editor-core';
import {
  createCameraOps,
  registerCameraAppliers,
  type CameraPose,
} from '../viewport-camera-appliers';

const unregisters: Array<() => void> = [];
afterEach(() => { for (const unregister of unregisters.splice(0)) unregister(); });

function makePose(): CameraPose {
  return {
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
    orthoHalfHeight: 10,
  };
}

describe('camera session appliers', () => {
  it('routes projection and view-scale operations through one runtime writer', () => {
    let pose = makePose();
    let writes = 0;
    unregisters.push(registerCameraAppliers(createCameraOps({
      editorEngine: { set: () => undefined } as never,
      camera: 1 as never,
      getPose: () => pose,
      setPose: (next) => { pose = next; },
      applyCamera: () => { writes += 1; },
      getBookmark: () => undefined,
      setBookmark: () => undefined,
      frameSelection: () => undefined,
    })));

    expect(gateway.dispatch({ kind: 'cameraSetProjection', projection: 'orthographic' }, 'ai'))
      .toMatchObject({ ok: true });
    expect(pose.projection).toBe('orthographic');
    expect(gateway.dispatch({ kind: 'cameraAdjustFov', delta: 1 }, 'human'))
      .toMatchObject({ ok: true });
    expect(pose.orthoHalfHeight).toBeLessThan(10);
    const shrunk = pose.orthoHalfHeight;
    expect(gateway.dispatch({ kind: 'cameraZoom', delta: -1 }, 'human'))
      .toMatchObject({ ok: true });
    expect(pose.orthoHalfHeight).toBeGreaterThan(shrunk);
    expect(writes).toBe(3);
  });

  it('saves, recalls, clears, and validates numbered camera bookmarks', () => {
    let pose = makePose();
    const bookmarks = new Map<number, CameraPose>();
    unregisters.push(registerCameraAppliers(createCameraOps({
      editorEngine: { set: () => undefined } as never,
      camera: 1 as never,
      getPose: () => pose,
      setPose: (next) => { pose = next; },
      applyCamera: () => undefined,
      getBookmark: (slot) => bookmarks.get(slot),
      setBookmark: (slot, bookmark) => {
        if (bookmark === null) bookmarks.delete(slot);
        else bookmarks.set(slot, bookmark);
      },
      frameSelection: () => undefined,
    })));

    expect(gateway.dispatch({ kind: 'cameraBookmark', action: 'save', slot: 1 }, 'human'))
      .toMatchObject({ ok: true });
    pose = { ...pose, yaw: 1.8 };
    expect(gateway.dispatch({ kind: 'cameraBookmark', action: 'recall', slot: 1 }, 'ai'))
      .toMatchObject({ ok: true });
    expect(pose.yaw).toBeCloseTo(0.5);
    expect(gateway.dispatch({ kind: 'cameraBookmark', action: 'clear', slot: 1 }, 'human'))
      .toMatchObject({ ok: true });
    expect(gateway.dispatch({ kind: 'cameraBookmark', action: 'recall', slot: 1 }, 'ai'))
      .toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
    expect(gateway.dispatch({ kind: 'cameraBookmark', action: 'save', slot: 10 }, 'human'))
      .toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
  });

  it('rejects non-finite poses and degenerate look-at vectors before writing', () => {
    let pose = makePose();
    let writes = 0;
    unregisters.push(registerCameraAppliers(createCameraOps({
      editorEngine: { set: () => undefined } as never,
      camera: 1 as never,
      getPose: () => pose,
      setPose: (next) => { pose = next; },
      applyCamera: () => { writes += 1; },
      getBookmark: () => undefined,
      setBookmark: () => undefined,
      frameSelection: () => undefined,
    })));

    expect(gateway.dispatch({ kind: 'cameraFly', pos: [Number.NaN, 0, 0], yaw: 0, pitch: 0 }, 'ai'))
      .toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
    expect(gateway.dispatch({ kind: 'cameraLookAt', pos: [1, 1, 1], lookAt: [1, 1, 1] }, 'ai'))
      .toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
    expect(writes).toBe(0);
  });

  it('cameraSetView switches to axis-aligned orthographic presets, cancelling live gestures', () => {
    let pose = makePose();
    let cancels = 0;
    unregisters.push(registerCameraAppliers(createCameraOps({
      editorEngine: { set: () => undefined } as never,
      camera: 1 as never,
      getPose: () => pose,
      setPose: (next) => { pose = next; },
      applyCamera: () => undefined,
      cancelNavigation: () => { cancels += 1; },
      getBookmark: () => undefined,
      setBookmark: () => undefined,
      frameSelection: () => undefined,
    })));

    expect(gateway.dispatch({ kind: 'cameraSetView', view: 'top' }, 'human'))
      .toMatchObject({ ok: true });
    expect(pose.projection).toBe('orthographic');
    expect(pose.pitch).toBe(-Math.PI / 2);
    expect(pose.yaw).toBe(0);
    // Orbit target stays — the preset view keeps looking at the same content.
    expect(pose.target).toEqual([0, 1, 0]);
    // View scale derived from the perspective framing (dist·tan(fov/2)).
    expect(pose.orthoHalfHeight).toBeCloseTo(10 * Math.tan(Math.PI / 6), 4);
    expect(cancels).toBe(1);

    // Switching between axis views preserves the current ortho view scale.
    expect(gateway.dispatch({ kind: 'cameraSetView', view: 'left' }, 'ai'))
      .toMatchObject({ ok: true });
    expect(pose.yaw).toBe(-Math.PI / 2);
    expect(pose.pitch).toBe(0);
    expect(pose.orthoHalfHeight).toBeCloseTo(10 * Math.tan(Math.PI / 6), 4);

    expect(gateway.dispatch({ kind: 'cameraSetView', view: 'isometric' as never }, 'ai'))
      .toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
  });

  it('cameraSetView perspective restores projection with a one-time pitch clamp (R5)', () => {
    let pose: CameraPose = {
      ...makePose(), projection: 'orthographic', pitch: -Math.PI / 2,
    };
    unregisters.push(registerCameraAppliers(createCameraOps({
      editorEngine: { set: () => undefined } as never,
      camera: 1 as never,
      getPose: () => pose,
      setPose: (next) => { pose = next; },
      applyCamera: () => undefined,
      getBookmark: () => undefined,
      setBookmark: () => undefined,
      frameSelection: () => undefined,
    })));

    expect(gateway.dispatch({ kind: 'cameraSetView', view: 'perspective' }, 'human'))
      .toMatchObject({ ok: true });
    expect(pose.projection).toBe('perspective');
    // ±90° must not survive into perspective — the next orbit gesture would
    // otherwise snap the view by 4° on its first delta.
    expect(pose.pitch).toBe(-1.5);
    expect(pose.yaw).toBe(0.5);
  });

  it('keeps the ±90° axis pitch across gesture-end cameraOrbit ops in ortho (R1)', () => {
    let pose: CameraPose = {
      ...makePose(), projection: 'orthographic', yaw: 0, pitch: -Math.PI / 2,
    };
    unregisters.push(registerCameraAppliers(createCameraOps({
      editorEngine: { set: () => undefined } as never,
      camera: 1 as never,
      getPose: () => pose,
      setPose: (next) => { pose = next; },
      applyCamera: () => undefined,
      getBookmark: () => undefined,
      setBookmark: () => undefined,
      frameSelection: () => undefined,
    })));

    // Pan/zoom gesture-ends ride cameraOrbit with the current yaw/pitch; the
    // perspective ±86° clamp must not snap a Top view back on pointer-up.
    expect(gateway.dispatch({ kind: 'cameraOrbit', yaw: 0, pitch: -Math.PI / 2 }, 'human'))
      .toMatchObject({ ok: true });
    expect(pose.pitch).toBe(-Math.PI / 2);
    // The perspective path still clamps.
    pose = { ...pose, projection: 'perspective' };
    expect(gateway.dispatch({ kind: 'cameraOrbit', pitch: -Math.PI / 2 }, 'human'))
      .toMatchObject({ ok: true });
    expect(pose.pitch).toBe(-1.5);
  });

  it('recalls orthographic bookmarks at ±90° without pitch corruption (R4)', () => {
    let pose: CameraPose = {
      ...makePose(), projection: 'orthographic', yaw: 0, pitch: -Math.PI / 2,
    };
    const bookmarks = new Map<number, CameraPose>();
    unregisters.push(registerCameraAppliers(createCameraOps({
      editorEngine: { set: () => undefined } as never,
      camera: 1 as never,
      getPose: () => pose,
      setPose: (next) => { pose = next; },
      applyCamera: () => undefined,
      getBookmark: (slot) => bookmarks.get(slot),
      setBookmark: (slot, bookmark) => {
        if (bookmark === null) bookmarks.delete(slot);
        else bookmarks.set(slot, bookmark);
      },
      frameSelection: () => undefined,
    })));

    expect(gateway.dispatch({ kind: 'cameraBookmark', action: 'save', slot: 2 }, 'human'))
      .toMatchObject({ ok: true });
    pose = { ...pose, yaw: 1.2, pitch: 0.4 };
    expect(gateway.dispatch({ kind: 'cameraBookmark', action: 'recall', slot: 2 }, 'human'))
      .toMatchObject({ ok: true });
    expect(pose.pitch).toBe(-Math.PI / 2);
    expect(pose.projection).toBe('orthographic');
  });
});
