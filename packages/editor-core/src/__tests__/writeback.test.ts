// w31 — writeback single-instance addressing + disk round-trip tests
// (TDD red stage).
//
// AC-14 (writeback addresses instance → source SceneAsset → pack) + AC-16
// (disk round-trip: an external writer edits the pack on disk; the editor
// reloads it and the edit-state world reflects the new pack). After the
// prior-model→SceneAsset/EditSession replacement (M6) these editor-core paths
// must NOT break.
//
// This pins the EDITOR-side writeback contract that is runtime-reachable in the
// editor's resolved engine (the engine-side instantiate→collectSceneAsset POD
// round-trip is separately covered by the engine's own
// collect-scene-asset.test.ts, w9/w10):
//   (1) addressing: serializing the active session targets the SCENE's stable
//       GUID (not an order-derived churning value) — a single instance addresses
//       exactly its own pack.
//   (2) disk round-trip: session → pack JSON → (disk) → parse → session is
//       structurally consistent (entity count, names, component values, scene
//       GUID survive).
//
// Anchors:
//   plan-tasks.json w31: writeback single-instance addressing + disk round-trip
//   requirements AC-14: writeback chain instance → SceneAsset → pack addressable
//   requirements AC-16: disk round-trip survives SceneAsset replacement
//   plan-strategy D-1: writeback consumes M2 collectSceneAsset (engine side)

import { describe, expect, it } from 'bun:test';

import {
  createEditSession,
  applyCommand,
} from '../document';
import {
  sessionToPack,
  packToSession,
  isScenePack,
  stableGuid,
} from '../scene-pack';
import type { EditSession } from '../types';

function fixtureSession(): EditSession {
  const s = createEditSession();
  applyCommand(s, {
    kind: 'spawnEntity',
    name: 'Ground',
    components: {
      Transform: { x: 0, y: 0, z: 0, scaleX: 10, scaleY: 1, scaleZ: 10 },
      Mesh: { kind: 'cube' },
      Material: { albedo: '#888888' },
    },
  });
  applyCommand(s, {
    kind: 'spawnEntity',
    name: 'Box',
    components: {
      Transform: { x: 1, y: 2, z: 3 },
      Mesh: { kind: 'cube' },
      Material: { albedo: '#ff0000' },
    },
  });
  return s;
}

describe('w31 — writeback addressing (single instance → its own pack GUID)', () => {
  it('serializes the session under the explicit scene GUID it is given', () => {
    const s = fixtureSession();
    const sceneGuid = 'aaaaaaaa-0000-5000-8000-0000000000ab';
    const pack = sessionToPack(s, sceneGuid);
    expect(isScenePack(pack)).toBe(true);
    const scene = pack.assets.find((a) => a.kind === 'scene');
    expect(scene).toBeDefined();
    // The scene asset must carry the GUID it was addressed with — the writeback
    // targets exactly that source SceneAsset (not an order-derived churn value).
    expect(scene!.guid).toBe(sceneGuid);
  });

  it('the scene GUID is stable across edits (does not churn on add/delete)', () => {
    const s = fixtureSession();
    const g = stableGuid('scene|.forgeax/games/demo/scenes/main.pack.json');
    const before = sessionToPack(s, g).assets.find((a) => a.kind === 'scene')!.guid;
    // Edit: add then delete an entity.
    applyCommand(s, { kind: 'spawnEntity', name: 'tmp' });
    const tmpId = s.order[s.order.length - 1]!;
    applyCommand(s, { kind: 'destroyEntity', entity: tmpId });
    const after = sessionToPack(s, g).assets.find((a) => a.kind === 'scene')!.guid;
    expect(after).toBe(before);
  });
});

describe('w31 — disk round-trip (session → pack JSON → parse → session)', () => {
  it('entity count, names and component values survive a JSON round-trip', () => {
    const s = fixtureSession();
    const sceneGuid = 'bbbbbbbb-0000-5000-8000-0000000000cd';
    // Serialize to the durable on-disk pack JSON (what saveDocToDisk writes).
    const json = JSON.stringify(sessionToPack(s, sceneGuid), null, 2);

    // Simulate an external writer / disk reload: parse the JSON and project it
    // back into a fresh edit session.
    const parsed = JSON.parse(json);
    expect(isScenePack(parsed)).toBe(true);
    const reloaded = packToSession(parsed);

    // Same number of authored entities survive.
    expect(reloaded.order.length).toBe(s.order.length);

    // Names survive.
    const names = reloaded.order.map((id) => reloaded.entities[id]!.name).sort();
    expect(names).toEqual(['Box', 'Ground']);

    // A component value survives (Box's red albedo).
    const box = reloaded.order
      .map((id) => reloaded.entities[id]!)
      .find((n) => n.name === 'Box');
    expect(box).toBeDefined();
    const mat = box!.components.Material as { albedo?: string } | undefined;
    expect(mat?.albedo).toBe('#ff0000');
  });

  it('a disk pack edited by an external writer reloads into the session', () => {
    const s = fixtureSession();
    const sceneGuid = 'cccccccc-0000-5000-8000-0000000000ef';
    const pack = sessionToPack(s, sceneGuid);

    // An external AI/agent edits the pack on disk: move the Box.
    const scene = pack.assets.find((a) => a.kind === 'scene')!;
    const entities = (scene.payload as { entities: Array<{ components: Record<string, Record<string, unknown>> }> }).entities;
    const boxEntity = entities.find((e) => (e.components.Name?.value as string) === 'Box');
    expect(boxEntity).toBeDefined();
    (boxEntity!.components.Transform as Record<string, number>).posX = 99;

    // The editor reloads the externally-modified pack.
    const reloaded = packToSession(pack);
    const box = reloaded.order
      .map((id) => reloaded.entities[id]!)
      .find((n) => n.name === 'Box');
    const t = box!.components.Transform as { x?: number } | undefined;
    expect(t?.x).toBe(99);
  });
});
