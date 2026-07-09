// init-scene-list-no-autobind.test.ts
//
// Regression: initSceneList() must NOT auto-bind the alphabetically-first scene
// pack when a game has kind:"scene" packs but no forge.json `defaultScene` (and
// no URL/localStorage binding).
//
// Root cause it guards: scene packs are discovered by `kind:"scene"` alone
// (assets.ts findAllScenePacks), with NO marker separating an authored MAIN scene
// from a runtime PREFAB. shoot-opt is a code-driven game whose only scene packs
// are enemy ship prefabs under assets/enemies/*.pack.json (instantiated at runtime
// via assets.instantiate). The old binding chain fell through to `firstScene`
// (sceneList[0], alphabetically first = assassin), loading an enemy prefab AS the
// editable scene; the first dirty-flush then serialized the live world back over
// that prefab file, corrupting the authored asset. The fix drops the firstScene
// fallback: with no explicit/authoritative binding, currentSceneFile stays null
// (the same legacy/seed path a game with zero scene packs, e.g. fps, takes).

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  gateway,
  initSceneList,
  getSceneFile,
  getSceneList,
  setPathResolver,
} from '@forgeax/editor-core';
import type { EditorOp } from '@forgeax/editor-core';

// Two enemy-prefab scene packs (kind:"scene", no defaultScene points at them) —
// the shoot-opt shape. `assassin` sorts before `bomber`, so the OLD code would
// have auto-bound `assassin`.
const PACKS: Record<string, string> = {
  '/game/assets/enemies/assassin.pack.json': JSON.stringify({
    schemaVersion: '1.0.0', kind: 'internal-text-package',
    assets: [{ guid: 'aaaa1111-0000-4000-8000-000000000001', kind: 'scene', payload: { entities: [] } }],
  }),
  '/game/assets/enemies/bomber.pack.json': JSON.stringify({
    schemaVersion: '1.0.0', kind: 'internal-text-package',
    assets: [{ guid: 'bbbb2222-0000-4000-8000-000000000002', kind: 'scene', payload: { entities: [] } }],
  }),
};

// forge.json with NO defaultScene (the shoot-opt case).
const FORGE_JSON_CONTENT = JSON.stringify({ id: 'shoot-opt', name: 'shoot-opt', schemaVersion: '1.0.0', entry: 'src/main.ts' });

// A files tree exposing exactly the two enemy packs under the game root '/game'.
const TREE = {
  tree: {
    name: 'game', path: '/game', type: 'dir' as const,
    children: [
      {
        name: 'assets', path: '/game/assets', type: 'dir' as const,
        children: [
          {
            name: 'enemies', path: '/game/assets/enemies', type: 'dir' as const,
            children: [
              { name: 'assassin.pack.json', path: '/game/assets/enemies/assassin.pack.json', type: 'file' as const },
              { name: 'bomber.pack.json', path: '/game/assets/enemies/bomber.pack.json', type: 'file' as const },
            ],
          },
        ],
      },
    ],
  },
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('initSceneList — no auto-bind to an unmarked scene pack (shoot-opt regression)', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    // Host seam: map game-relative paths to our fake '/game/<rel>' namespace.
    setPathResolver((rel: string) => (rel ? `/game/${rel}` : '/game'));
    // Stub the network: files/tree → TREE, forge.json → no defaultScene, packs → PACKS.
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/files/tree?root=')) return jsonResponse(TREE);
      if (url.startsWith('/api/files?path=')) {
        const path = decodeURIComponent(url.slice('/api/files?path='.length));
        if (path === '/game/forge.json') return jsonResponse({ content: FORGE_JSON_CONTENT });
        if (path in PACKS) return jsonResponse({ content: PACKS[path] });
        return new Response('not found', { status: 404 });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    // Bind the store to the game slug (initSceneList early-returns for 'default').
    gateway.dispatch({ kind: 'setSceneId', id: 'shoot-opt' } as EditorOp);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    setPathResolver(null);
    gateway.dispatch({ kind: 'setSceneId', id: null } as EditorOp);
    try { localStorage.clear(); } catch { /* no localStorage in this env */ }
  });

  it('discovers the scene packs but leaves currentSceneFile null (no firstScene fallback)', async () => {
    await initSceneList();
    // Both enemy prefabs are DISCOVERED (kind:"scene" scan is unchanged)…
    expect(getSceneList().map((s) => s.id).sort()).toEqual(['assassin', 'bomber']);
    // …but NONE is auto-bound as the editable scene (the corruption trigger).
    expect(getSceneFile()).toBeNull();
  });
});
