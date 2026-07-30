import { describe, expect, test } from 'bun:test';
import { createGameplayOperations } from '../io/gameplay-operations';

describe('live gameplay operations', () => {
  test('maps play, input, query, and gameplay stop to the live gateway', async () => {
    const calls: unknown[] = [];
    const gateway = {
      dispatch: (operation: unknown) => { calls.push(operation); return { ok: true }; },
      invokeGameAction: async (id: string, args: unknown) => { calls.push({ id, args }); return { ok: true, value: undefined }; },
      readGameState: async (id: string) => { calls.push({ id }); return { ok: true, value: { entities: [] } }; },
      playPhase: 'play',
    } as never;
    const operations = createGameplayOperations(gateway);

    await expect(operations.play()).resolves.toEqual({ ok: true, state: 'running' });
    await expect(operations.input({ type: 'key', key: 'ArrowRight', phase: 'down' })).resolves.toEqual({ ok: true });
    await expect(operations.query('')).resolves.toEqual({ ok: true, data: { entities: [] } });
    await expect(operations.gameplayStop()).resolves.toEqual({ ok: true, state: 'stopped' });
    expect(calls).toEqual([
      { id: 'input', args: { type: 'key', key: 'ArrowRight', phase: 'down' } },
      { id: 'world' },
      { kind: 'stop' },
    ]);
  });

  test('waits for asynchronous Play assembly before reporting a running surface', async () => {
    let phase: 'starting' | 'play' = 'starting';
    const gateway = {
      dispatch: () => {
        setTimeout(() => { phase = 'play'; }, 5);
        return { ok: true };
      },
      invokeGameAction: async () => ({ ok: true, value: undefined }),
      readGameState: async () => ({ ok: true, value: { entities: [] } }),
      get playPhase() { return phase; },
      lastPlayError: null,
    } as never;
    const operations = createGameplayOperations(gateway);

    await expect(operations.play()).resolves.toEqual({ ok: true, state: 'running' });
  });

  test('reports unavailable without touching the gateway', async () => {
    const gateway = { playPhase: 'edit' } as never;
    const operations = createGameplayOperations(gateway);
    await expect(operations.input({ type: 'key', key: 'x', phase: 'up' })).resolves.toMatchObject({ ok: false });
    await expect(operations.query('')).resolves.toMatchObject({ ok: false });
  });
});
