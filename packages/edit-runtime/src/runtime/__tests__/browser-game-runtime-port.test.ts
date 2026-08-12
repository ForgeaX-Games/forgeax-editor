import { expect, test } from 'bun:test';

import { createBrowserGameRuntimePort } from '../browser-game-runtime-port';

function makeLifecycle() {
  const calls: string[] = [];
  let world: object | null = null;
  return {
    calls,
    lifecycle: {
      async playSimulation() { calls.push('play'); world = {}; },
      stopSimulation() { calls.push('stop'); world = null; },
      dispose() { calls.push('dispose'); world = null; },
      currentPlayWorld() { return world; },
      getPlayPauseHandle() { return null; },
      currentPlayRunId() { return world === null ? null : 'play-run'; },
    },
  };
}

test('browser runtime adapter keeps edit facts stable across ten world forks', async () => {
  const fixture = makeLifecycle();
  const port = createBrowserGameRuntimePort({
    lifecycle: fixture.lifecycle,
    query: async () => ({ ok: true, value: { authoredBytes: 'stable' } }),
  });

  for (let index = 0; index < 10; index++) {
    expect((await port.play()).ok).toBe(true);
    expect((await port.query('authoredBytes')).ok).toBe(true);
    expect((await port.stop()).ok).toBe(true);
    expect(port.availability().capabilities.play.available).toBe(true);
  }

  expect(fixture.calls).toEqual([
    'play', 'stop', 'play', 'stop', 'play', 'stop', 'play', 'stop', 'play', 'stop',
    'play', 'stop', 'play', 'stop', 'play', 'stop', 'play', 'stop', 'play', 'stop',
  ]);
});

test('browser runtime adapter returns structured stale handle failures', async () => {
  const fixture = makeLifecycle();
  const port = createBrowserGameRuntimePort({
    lifecycle: fixture.lifecycle,
    query: async () => ({
      ok: false as const,
      error: {
        code: 'entity-state-stale-handle',
        hint: 'query the active world',
        retryable: false,
        recoveryActions: ['runtime.query'],
      },
    }),
  });

  const result = await port.query('entity:old');
  expect(result).toMatchObject({ ok: false, error: { code: 'entity-state-stale-handle', retryable: false } });
});
