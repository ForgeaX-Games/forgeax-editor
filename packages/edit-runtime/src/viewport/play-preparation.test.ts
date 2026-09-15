import { describe, expect, test } from 'bun:test';
import { createPlayPreparation } from './play-preparation';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function target(log: string[], name: string) {
  return {
    prepareScene: async () => { log.push(`save:${name}`); },
    play: () => { log.push(`play:${name}`); return { ok: true as const }; },
    stop: () => { log.push(`stop:${name}`); },
    isPlaying: () => false,
  };
}

describe('host Play preparation', () => {
  test('waits for reconciliation and starts only the replacement realm', async () => {
    const log: string[] = [];
    const barrier = deferred();
    const prep = createPlayPreparation(async () => { await barrier.promise; });
    const detach = prep.attach(target(log, 'old'));
    const run = prep.play();
    await Promise.resolve();
    detach();
    prep.attach(target(log, 'new'));
    barrier.resolve();
    expect(await run.completion).toEqual({ ok: true });
    expect(log).toEqual(['save:old', 'play:new']);
  });
  test('Stop during preparation fences late completion', async () => {
    const log: string[] = [];
    const barrier = deferred();
    const prep = createPlayPreparation(async () => { await barrier.promise; });
    prep.attach(target(log, 'old'));
    const run = prep.play();
    prep.stop();
    expect((await run.completion)?.ok).toBe(false);
    prep.attach(target(log, 'new'));
    barrier.resolve();
    await Promise.resolve();
    expect(log.some((item) => item.startsWith('play:'))).toBe(false);
  });
  test('game disposal fences a remote preparation', async () => {
    const barrier = deferred();
    const prep = createPlayPreparation(async () => { await barrier.promise; });
    const log: string[] = [];
    prep.attach(target(log, 'old'));
    const result = prep.prepareRequest('request', 'last-saved', new AbortController().signal);
    prep.dispose();
    await expect(result).rejects.toMatchObject({ code: 'play-cancelled' });
    barrier.resolve();
    expect(prep.play().ok).toBe(false);
  });
  test('remote one-use preparation avoids replacing its new transport again', async () => {
    const log: string[] = [];
    let checks = 0;
    const prep = createPlayPreparation(async () => { checks += 1; });
    prep.attach(target(log, 'new'));
    await prep.prepareRequest('request', 'last-saved', new AbortController().signal);
    expect(await prep.play('last-saved', 'ai', 'request').completion).toEqual({ ok: true });
    expect(checks).toBe(1);
    expect(await prep.play('last-saved', 'ai', 'another').completion).toEqual({ ok: true });
    expect(checks).toBe(2);
  });
  test('save failure never rebuilds or starts the realm', async () => {
    let checks = 0;
    const log: string[] = [];
    const prep = createPlayPreparation(async () => { checks += 1; });
    prep.attach({ ...target(log, 'old'), prepareScene: async () => { throw { code: 'play-save-failed', hint: 'disk full' }; } });
    expect(await prep.play('save-then-play').completion).toMatchObject({ ok: false, error: { code: 'play-save-failed' } });
    expect(checks).toBe(0);
    expect(log).toEqual([]);
  });
});

for (const interruption of ['stop', 'detach'] as const) {
  test(`prepared remote request cannot restart after ${interruption}`, async () => {
    const log: string[] = [];
    let checks = 0;
    const prep = createPlayPreparation(async () => { checks += 1; });
    const detach = prep.attach(target(log, 'old'));
    await prep.prepareRequest('request', 'last-saved', new AbortController().signal);
    if (interruption === 'stop') prep.stop(); else detach();
    prep.attach(target(log, 'replacement'));
    expect(await prep.play('last-saved', 'ai', 'request').completion).toMatchObject({ ok: false, error: { code: 'play-cancelled' } });
    expect(checks).toBe(1);
    expect(log.some((item) => item.startsWith('play:'))).toBe(false);
  });
}

test('only an already-dispatched Play passes its request ID to runtime preparation', async () => {
  const requestIds: Array<string | undefined> = [];
  const prep = createPlayPreparation(async (_signal, requestId) => { requestIds.push(requestId); });
  prep.attach(target([], 'current'));
  await expect(prep.play('last-saved', 'human', 'human-play').completion).resolves.toEqual({ ok: true });
  await prep.prepareRequest('remote-play', 'last-saved', new AbortController().signal);
  await expect(prep.play('last-saved', 'ai', 'remote-play').completion).resolves.toEqual({ ok: true });
  expect(requestIds).toEqual(['human-play', undefined]);
});
