import { beforeEach, describe, expect, test } from 'bun:test';
import {
  invalidateWorkbenchCatalog,
  isWorkbenchHostExtension,
  loadSharedWorkbenchCatalog,
  loadWorkbenchCatalog,
} from './workbenchRuntime';

describe('Workbench catalog runtime', () => {
  beforeEach(() => invalidateWorkbenchCatalog());

  test('routes only the declared handshake extension through the Host', () => {
    expect(isWorkbenchHostExtension('@forgeax-extension/wb-game-video')).toBe(true);
    expect(isWorkbenchHostExtension('@forgeax-extension/wb-reel')).toBe(false);
  });

  test('loads the catalog from the formal same-origin Host API', async () => {
    const urls: string[] = [];
    const entries = await loadWorkbenchCatalog('game/one', async (input) => {
      urls.push(String(input));
      return Response.json({
        entries: [{
          extensionId: '@forgeax-extension/wb-game-video',
          runtimeId: 'runtime-video',
          title: 'Video Game Studio',
          runtimeUrl: 'extension/runtime-video/',
        }],
      });
    });

    expect(urls).toEqual(['/__workbench__/v1/catalog?gameId=game%2Fone']);
    expect(entries).toEqual([expect.objectContaining({
      extensionId: '@forgeax-extension/wb-game-video',
      runtimeUrl: '/__workbench__/v1/extension/runtime-video/',
    })]);
  });

  test('deduplicates sibling Page panel catalog requests', async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return Response.json({ entries: [] });
    };
    const left = loadSharedWorkbenchCatalog('game-one', fetcher);
    const center = loadSharedWorkbenchCatalog('game-one', fetcher);

    expect(left).toBe(center);
    await Promise.all([left, center]);
    expect(calls).toBe(1);
  });

  test('does not cache a failed Host request', async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return calls === 1
        ? new Response('unavailable', { status: 503 })
        : Response.json({ entries: [] });
    };

    await expect(loadSharedWorkbenchCatalog('game-one', fetcher)).rejects.toThrow('503');
    await expect(loadSharedWorkbenchCatalog('game-one', fetcher)).resolves.toEqual([]);
    expect(calls).toBe(2);
  });
});
