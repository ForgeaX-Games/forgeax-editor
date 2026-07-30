import { expect, test } from 'bun:test';

import { createBunGameRuntimePort } from '../public/runtime';

test('Bun adapter projects simulation capabilities without a display dependency', () => {
  const port = createBunGameRuntimePort({ createPlayWorld: () => ({ worldId: 'projection-world' }) });
  const availability = port.availability();
  expect(availability.host).toBe('bun');
  expect(availability.blocking).toBe(false);
  expect(availability.capabilities.play).toMatchObject({ available: true });
  expect(availability.capabilities.fixedStep).toMatchObject({ available: true });
  expect(availability.capabilities.capture).toMatchObject({ available: false, code: 'display-unavailable' });
  expect(availability.capabilities.reveal).toMatchObject({ available: false, code: 'display-unavailable' });
});

test('runtime availability remains useful when the active world is absent', async () => {
  const port = createBunGameRuntimePort({ createPlayWorld: () => ({ worldId: 'projection-world' }) });
  const query = await port.query('scene');
  expect(query.ok ? undefined : query.error.code).toBe('runtime-not-running');
  expect(port.availability().capabilities.query).toMatchObject({ available: true });
});
