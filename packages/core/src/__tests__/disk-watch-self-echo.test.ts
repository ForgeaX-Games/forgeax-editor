// disk-watch-self-echo — the self-save echo decision that keeps a manual scene
// save from being mistaken for an external edit (which would force Studio to
// remount the viewport and reload the WHOLE scene: WebGPU dispose + reboot +
// full instantiate — the "saving reloads the entire scene" slowness).
//
// The prior echo detection re-serialised the LIVE world and byte-compared it to
// disk. That was fragile: any edit landing between the save and the watcher
// firing, a null currentSceneGuid at save time, or platform newline
// normalisation all made the compare fail → the save was treated as external →
// full reload. isSelfSaveEcho instead compares the disk bytes against the EXACT
// bytes we recorded at save time, with a time-window fallback for the newline
// case. These cases pin that contract headlessly (no WebSocket / timers / net).

import { describe, expect, it } from 'bun:test';
import { isSelfSaveEcho, SELF_SAVE_ECHO_WINDOW_MS } from '../store/disk-watch';
import type { LastSelfSave } from '../store/scene-persistence';

const SCENE = '/games/g1/scene.pack.json';
const BYTES = '{"assets":[{"kind":"scene"}]}\n';

function save(over?: Partial<LastSelfSave>): LastSelfSave {
  return { path: SCENE, content: BYTES, at: 1_000_000, ...over };
}

describe('isSelfSaveEcho — recognises our own save (suppress full reload)', () => {
  it('is an echo when the on-disk bytes match exactly what we wrote', async () => {
    const echo = await isSelfSaveEcho({
      eventPath: SCENE,
      activeScenePath: SCENE,
      lastSelfSave: save(),
      isDirty: false,
      now: save().at + 10,
      readDisk: async () => BYTES,
    });
    expect(echo).toBe(true);
  });

  it('is an echo across a Windows path separator mismatch (normalised compare)', async () => {
    const echo = await isSelfSaveEcho({
      eventPath: 'C:\\games\\g1\\scene.pack.json',
      activeScenePath: 'C:/games/g1/scene.pack.json',
      lastSelfSave: save({ path: 'C:/games/g1/scene.pack.json' }),
      isDirty: false,
      now: save().at + 10,
      readDisk: async () => BYTES,
    });
    expect(echo).toBe(true);
  });

  it('falls back to the time-window when the server reformatted the bytes (newlines)', async () => {
    const echo = await isSelfSaveEcho({
      eventPath: SCENE,
      activeScenePath: SCENE,
      lastSelfSave: save(),
      isDirty: false,
      now: save().at + SELF_SAVE_ECHO_WINDOW_MS - 1,
      readDisk: async () => BYTES.replace(/\n/g, '\r\n'), // disk differs byte-wise
    });
    expect(echo).toBe(true);
  });
});

describe('isSelfSaveEcho — treats genuine external changes as NOT an echo (reload)', () => {
  it('is NOT an echo when nothing was saved this session', async () => {
    const echo = await isSelfSaveEcho({
      eventPath: SCENE,
      activeScenePath: SCENE,
      lastSelfSave: null,
      isDirty: false,
      now: 1_000_000,
      readDisk: async () => BYTES,
    });
    expect(echo).toBe(false);
  });

  it('is NOT an echo when disk bytes differ and the window has elapsed', async () => {
    const echo = await isSelfSaveEcho({
      eventPath: SCENE,
      activeScenePath: SCENE,
      lastSelfSave: save(),
      isDirty: false,
      now: save().at + SELF_SAVE_ECHO_WINDOW_MS + 1,
      readDisk: async () => '{"assets":[{"kind":"scene"},{"kind":"material"}]}\n',
    });
    expect(echo).toBe(false);
  });

  it('is NOT an echo (via the fallback) when an edit landed since the save', async () => {
    // Byte-compare fails (external tool wrote something else); the fallback is
    // gated on !isDirty, so an in-editor edit since save cannot mask a real
    // external change.
    const echo = await isSelfSaveEcho({
      eventPath: SCENE,
      activeScenePath: SCENE,
      lastSelfSave: save(),
      isDirty: true,
      now: save().at + 10,
      readDisk: async () => 'something else entirely',
    });
    expect(echo).toBe(false);
  });

  it('is NOT an echo when the changed file is not the active scene', async () => {
    const echo = await isSelfSaveEcho({
      eventPath: '/games/g1/other.pack.json',
      activeScenePath: SCENE,
      lastSelfSave: save(),
      isDirty: false,
      now: save().at + 10,
      readDisk: async () => BYTES,
    });
    expect(echo).toBe(false);
  });

  it('is NOT an echo when there is no active scene', async () => {
    const echo = await isSelfSaveEcho({
      eventPath: SCENE,
      activeScenePath: null,
      lastSelfSave: save(),
      isDirty: false,
      now: save().at + 10,
      readDisk: async () => BYTES,
    });
    expect(echo).toBe(false);
  });

  it('is NOT an echo when the recorded save was for a different scene path', async () => {
    // currentSceneGuid-null-style drift: we saved a different level; a change to
    // the now-active scene must not be masked by the stale recording.
    const echo = await isSelfSaveEcho({
      eventPath: SCENE,
      activeScenePath: SCENE,
      lastSelfSave: save({ path: '/games/g1/level2.pack.json' }),
      isDirty: false,
      now: save().at + 10,
      readDisk: async () => 'unrelated disk content',
    });
    expect(echo).toBe(false);
  });
});
