import { expect, test } from 'bun:test';

import type { GameRuntimePort, RuntimeResult } from '../contracts/runtime';

function assertRuntimePort(port: GameRuntimePort): void {
  const operations: Array<keyof GameRuntimePort> = [
    'availability',
    'play',
    'stop',
    'query',
    'fixedStep',
    'dispose',
    'capture',
    'reveal',
  ];
  for (const operation of operations) expect(typeof port[operation]).toBe('function');
}

test('runtime port exposes simulation and optional display seams as one contract', async () => {
  const results: RuntimeResult<unknown>[] = [];
  const port = {
    availability: () => ({
      version: 'game-runtime/v1' as const,
      host: 'bun' as const,
      blocking: false,
      capabilities: {},
    }),
    async play() { return { ok: true as const, value: { worldId: 'play-1' } }; },
    async stop() { return { ok: true as const, value: undefined }; },
    async query() { return { ok: true as const, value: { worldId: 'play-1' } }; },
    async fixedStep(_deltaMs: number) { return { ok: true as const, value: undefined }; },
    async dispose() { return { ok: true as const, value: undefined }; },
    async capture() { return { ok: false as const, error: { code: 'display-unavailable', hint: 'not available', retryable: false, recoveryActions: [] } }; },
    async reveal() { return { ok: false as const, error: { code: 'display-unavailable', hint: 'not available', retryable: false, recoveryActions: [] } }; },
  } satisfies GameRuntimePort;

  assertRuntimePort(port);
  results.push(await port.play(), await port.query(), await port.fixedStep(16), await port.stop(), await port.dispose());
  expect(results.every((result) => result.ok)).toBe(true);
  expect((await port.capture()).ok).toBe(false);
});
