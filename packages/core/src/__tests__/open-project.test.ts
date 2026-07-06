// w13 — openProject projection tests (TDD red stage).
//
// Tests scripted BEFORE openProject exists. The function signature is:
//   openProject(pointer: string, reader: (path: string) => Promise<string>)
//
// The reader receives project-relative file paths:
//   - 'forge.json' → forge.json content
//   - 'scenes/main.pack.json' → the default scene pack (when defaultScene is set)
//
// openProject internally:
//   1. Calls loadGameProject(read) with the injected reader.
//   2. If defaultScene is set, resolves the scene pack via reader,
//      instantiates the SceneAsset into a new World.
//   3. If defaultScene absent, returns a fresh World with no scene root
//      (graceful skip — no throw).
//
// Coverage:
//   (a) fixture with defaultScene → returned world has entityCount > 0
//   (b) fixture without defaultScene → returned world exists, entityCount === 0
//       (no throw, graceful skip)
//
// Anchors:
//   plan-tasks.json w13: openProject projection unit test
//   requirements AC-06: editor world has defaultScene projection after openProject
//   requirements edge-case: project without defaultScene skips instantiate gracefully
//   plan-strategy D-10: reader injected into loadGameProject

import { describe, expect, it } from 'bun:test';
// Importing the runtime barrel registers the canonical built-in components
// (Name / Transform / ChildOf / SceneInstance / …) into the shared global
// registry, which world.instantiateScene resolves by name. Do NOT re-define
// these names here: a second defineComponent('Transform', …) with a different
// schema overwrites the canonical token in the shared registry and corrupts
// every other test in the same process (the tokens spawned entities were
// created with stop resolving). Depend on the real registrations instead.
import '@forgeax/engine-runtime';

// ═══════════════════════════════════════════════════════════════════════════════
// Fixture data
// ═══════════════════════════════════════════════════════════════════════════════

const SCENE_GUID = 'aaaaaaaa-0000-5000-8000-000000000001';

/** forge.json WITH defaultScene (cow-level style). */
const FORGE_WITH_SCENE = JSON.stringify({
  id: 'test-game',
  name: 'Test Game',
  schemaVersion: '1.0.0',
  entry: 'main.ts',
  defaultScene: SCENE_GUID,
});

/** forge.json WITHOUT defaultScene (fps style). */
const FORGE_WITHOUT_SCENE = JSON.stringify({
  id: 'test-fps',
  name: 'Test FPS',
  schemaVersion: '1.0.0',
  entry: 'main.ts',
});

/** A minimal scene pack containing one entity with Transform and Name. */
const SCENE_PACK = JSON.stringify({
  schemaVersion: '1.0.0',
  kind: 'internal-text-package',
  assets: [
    {
      guid: SCENE_GUID,
      kind: 'scene',
      payload: {
        kind: 'scene',
        entities: [
          {
            localId: 0,
            components: {
              Name: { value: 'Root' },
              Transform: {
                posX: 0,
                posY: 0,
                posZ: 0,
                scaleX: 1,
                scaleY: 1,
                scaleZ: 1,
              },
            },
          },
        ],
      },
    },
  ],
});

// ═══════════════════════════════════════════════════════════════════════════════
// Helper: create a mock reader from a path→content map
// ═══════════════════════════════════════════════════════════════════════════════

function mapReader(
  files: Record<string, string>,
): (path: string) => Promise<string> {
  return async (path: string) => {
    const content = files[path];
    if (content === undefined) {
      throw new Error(`File not found: ${path}`);
    }
    return content;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tests — will be RED until openProject is implemented (TDD)
// ═══════════════════════════════════════════════════════════════════════════════

import { openProject, type OpenProjectResult } from '../session/open-project';

describe('w13 — openProject projection', () => {
  it('(a) fixture with defaultScene -> world has entityCount > 0', async () => {
    const reader = mapReader({
      'forge.json': FORGE_WITH_SCENE,
      'scenes/main.pack.json': SCENE_PACK,
    });

    const result = await openProject('test-game', reader);

    expect(result).toBeDefined();
    expect(result.world).toBeDefined();

    const snap = result.world.inspect();
    // At minimum the scene root entity should exist.
    // (SceneInstance + its owned entities)
    expect(snap.entityCount).toBeGreaterThan(0);
    expect(result.sceneRoot).toBeGreaterThan(0);
    // P3 discriminant: a real scene was projected.
    expect(result.status).toBe('opened');
    expect(result.ok).toBe(true);
  });

  it('(b) fixture without defaultScene -> graceful skip (no throw, world exists)', async () => {
    const reader = mapReader({
      'forge.json': FORGE_WITHOUT_SCENE,
    });

    const result = await openProject('test-fps', reader);

    expect(result).toBeDefined();
    expect(result.world).toBeDefined();

    const snap = result.world.inspect();
    // No scene root entity — graceful skip, not a throw.
    expect(result.sceneRoot).toBeNull();
    // World is empty (no entities from scene instantiation).
    expect(snap.entityCount).toBe(0);
    // P3 discriminant: a successful open with no scene is NOT a failure —
    // distinguishable from a load failure that also yields sceneRoot=null.
    expect(result.status).toBe('no-scene');
    expect(result.ok).toBe(true);
  });

  it('(c) invalid forge.json -> load-failed status (distinct from no-scene)', async () => {
    // forge.json present but not valid JSON -> loadGameProject fails. This must
    // be distinguishable from case (b): both yield sceneRoot=null, only the
    // status/ok discriminant tells them apart (charter P3).
    const reader = mapReader({
      'forge.json': '{ not valid json',
    });

    const result = await openProject('test-broken', reader);

    expect(result).toBeDefined();
    expect(result.world).toBeDefined();
    expect(result.sceneRoot).toBeNull();
    expect(result.status).toBe('load-failed');
    expect(result.ok).toBe(false);
  });
});