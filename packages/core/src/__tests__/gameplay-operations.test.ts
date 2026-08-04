import { describe, expect, test } from 'bun:test';
import { createGameplayOperations } from '../io/gameplay-operations';

describe('live gameplay operations', () => {
  test('maps input and query to the already-running live gateway', async () => {
    const calls: unknown[] = [];
    const gateway = {
      invokeGameAction: async (id: string, args: unknown) => { calls.push({ id, args }); return { ok: true, value: undefined }; },
      readGameState: async (id: string) => { calls.push({ id }); return { ok: true, value: { entities: [] } }; },
      listGameActions: () => [{ id: 'input', title: 'Input', argsSchema: null }],
      listGameReads: () => [{ id: 'world', title: 'World' }],
      playPhase: 'play',
    } as never;
    const operations = createGameplayOperations(gateway);

    expect(operations.describe()).toEqual({
      actions: [{ id: 'input', title: 'Input', argsSchema: null }],
      reads: [{ id: 'world', title: 'World' }],
    });
    await expect(operations.input({ type: 'key', key: 'ArrowRight', phase: 'down' })).resolves.toEqual({ ok: true });
    await expect(operations.query('')).resolves.toEqual({ ok: true, data: { entities: [] } });
    expect(calls).toEqual([
      { id: 'input', args: { type: 'key', key: 'ArrowRight', phase: 'down' } },
      { id: 'world' },
    ]);
  });

  test('reports unavailable without touching the gateway', async () => {
    const gateway = {
      playPhase: 'edit',
      listGameActions: () => [],
      listGameReads: () => [],
    } as never;
    const operations = createGameplayOperations(gateway);
    await expect(operations.input({ type: 'key', key: 'x', phase: 'up' })).resolves.toMatchObject({ ok: false });
    await expect(operations.query('')).resolves.toMatchObject({ ok: false });
  });
});
