import { expect, test } from 'bun:test';

import { createBunGameRuntimePort } from './bun-game-runtime-port';

test('Bun runtime completes play, query, fixedStep, stop, and dispose without a viewport', async () => {
  const calls: string[] = [];
  const authored = { bytes: 'authored-stable' };
  const port = createBunGameRuntimePort({
    createPlayWorld: () => ({ worldId: 'play-1', entities: ['root'] }),
    authoredSnapshot: () => authored,
    query: async (world, query) => ({ worldId: world.worldId, query, entities: world.entities }),
    fixedStep: async (world, deltaMs) => { calls.push(`${world.worldId}:${deltaMs}`); },
    disposePlayWorld: (world) => { calls.push(`dispose:${world.worldId}`); },
  });

  expect((await port.play()).ok).toBe(true);
  expect(await port.query('world')).toMatchObject({ ok: true, value: { worldId: 'play-1' } });
  expect((await port.fixedStep(16)).ok).toBe(true);
  expect((await port.stop()).ok).toBe(true);
  expect((await port.dispose()).ok).toBe(true);
  expect(calls).toEqual(['play-1:16', 'dispose:play-1']);
  expect(port.authoredSnapshot()).toEqual(authored);
  expect(port.availability().capabilities.capture?.available).toBe(false);
});

test('Bun runtime rejects a handle from a previous play world instead of resolving it', async () => {
  let worldCount = 0;
  const port = createBunGameRuntimePort({
    createPlayWorld: () => ({ worldId: `play-${++worldCount}`, entities: [] }),
  });

  const first = await port.play();
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  const firstWorldId = first.value.worldId;
  await port.stop();
  await port.play();

  const result = await port.query({ worldId: firstWorldId, entityId: 'entity-1' });
  expect(result).toMatchObject({ ok: false, error: { code: 'entity-state-stale-handle', retryable: false } });
});
