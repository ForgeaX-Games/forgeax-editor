import { expect, test } from 'bun:test';

import { createHeadlessRuntime } from '../headless-runtime';

test('headless runtime never reports UNKNOWN_OP for simulation operations', async () => {
  const runtime = createHeadlessRuntime({
    port: {
      availability: () => ({ version: 'game-runtime/v1', host: 'bun', blocking: false, capabilities: {} }),
      play: async () => ({ ok: true as const, value: { worldId: 'play' } }),
      stop: async () => ({ ok: true as const, value: undefined }),
      query: async () => ({ ok: true as const, value: { running: true } }),
      fixedStep: async () => ({ ok: true as const, value: undefined }),
      dispose: async () => ({ ok: true as const, value: undefined }),
      capture: async () => ({ ok: false as const, error: { code: 'display-unavailable', hint: 'no display', retryable: false, recoveryActions: [] } }),
      reveal: async () => ({ ok: false as const, error: { code: 'display-unavailable', hint: 'no display', retryable: false, recoveryActions: [] } }),
    },
  });

  expect((await runtime.play()).ok).toBe(true);
  expect((await runtime.query('world')).ok).toBe(true);
  expect((await runtime.fixedStep(16)).ok).toBe(true);
  expect((await runtime.stop()).ok).toBe(true);
  expect((await runtime.dispose()).ok).toBe(true);
});
