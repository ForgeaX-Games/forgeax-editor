import { describe, expect, test } from 'bun:test';
import { createGameplayOperations, createRemoteGameplayGateway } from '../io/gameplay-operations';

describe('live gameplay operations', () => {
  test('maps input and query to the already-running live gateway', async () => {
    const calls: unknown[] = [];
    const gateway = {
      invokeGameAction: async (id: string, args: unknown) => { calls.push({ id, args }); return { ok: true, value: { acknowledged: 1 } }; },
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
    await expect(operations.input({ type: 'key', key: 'ArrowRight', phase: 'down' })).resolves.toEqual({ ok: true, data: { acknowledged: 1 } });
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

  test('adapts a remote Play projection to the Gateway-shaped surface', async () => {
    const requests: unknown[] = [];
    let phase: 'edit' | 'play' = 'play';
    const gateway = createRemoteGameplayGateway({
      descriptors: () => ({
        actions: [{ id: 'input', title: 'Input', argsSchema: null }],
        reads: [{ id: 'state', title: 'State' }],
      }),
      request: async (request) => {
        requests.push(request);
        return request.operation === 'read'
          ? { ok: true as const, data: { score: 7 } }
          : { ok: true as const, data: { acknowledged: 1 } };
      },
    }, () => phase);

    expect(gateway.listGameActions()).toEqual([{ id: 'input', title: 'Input', argsSchema: null }]);
    expect(gateway.listGameReads()).toEqual([{ id: 'state', title: 'State' }]);
    await expect(gateway.invokeGameAction('input', { key: 'ArrowRight' })).resolves.toEqual({ ok: true, value: { acknowledged: 1 } });
    await expect(gateway.readGameState('state')).resolves.toEqual({ ok: true, value: { score: 7 } });
    phase = 'edit';
    await expect(gateway.readGameState('state')).resolves.toMatchObject({ ok: false, error: { code: 'game-projection-unavailable' } });
    expect(requests).toEqual([
      { operation: 'run', id: 'input', args: { key: 'ArrowRight' } },
      { operation: 'read', id: 'state' },
    ]);
  });

  test('retries an idempotent remote read after a retryable carrier timeout', async () => {
    let attempts = 0;
    const gateway = createRemoteGameplayGateway({
      descriptors: () => ({ actions: [], reads: [{ id: 'state', title: 'State' }] }),
      request: async (request) => {
        if (request.operation !== 'read') return { ok: true as const };
        attempts += 1;
        if (attempts === 1) {
          return {
            ok: false as const,
            error: {
              code: 'play-gameplay-request-timeout',
              hint: 'the disposable Play child reloaded while the read was in flight',
              retryable: true,
            },
          };
        }
        return { ok: true as const, data: { phase: 'play' } };
      },
    }, () => 'play');

    await expect(gateway.readGameState('state')).resolves.toEqual({ ok: true, value: { phase: 'play' } });
    expect(attempts).toBe(2);
  });
});
