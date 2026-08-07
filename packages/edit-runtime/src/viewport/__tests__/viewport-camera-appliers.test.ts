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
});
