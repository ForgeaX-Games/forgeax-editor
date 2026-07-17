import { afterEach, describe, expect, test } from 'bun:test';
import { createEditorVisualSource, registerEditorVisualHost } from './visual-source';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Editor visual source prior catalog', () => {
  test('resolves a continuity key through the active game manifest', async () => {
    const requests: string[] = [];
    const unregister = registerEditorVisualHost({
      gateway: {
        activeWorld: {} as never,
        mode: 'play',
        subscribe: () => () => {},
      },
      canvas: {} as HTMLCanvasElement,
      gameRoot: '.forgeax/games/market',
      getActiveCameraEntity: () => undefined,
    });
    const source = createEditorVisualSource();
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.startsWith('/api/files?')) {
        return Response.json({
          content: JSON.stringify({
            version: 1,
            entries: [{
              continuityKey: 'market-night',
              image: 'visual-priors/market-night.jpg',
            }],
          }),
        });
      }
      return new Response(new Blob(['image'], { type: 'image/jpeg' }));
    }) as typeof fetch;

    const image = await source.resolveSeedImage('market-night');

    expect(image.type).toBe('image/jpeg');
    expect(requests).toEqual([
      '/api/files?path=.forgeax%2Fgames%2Fmarket%2Fvisual-priors%2Fmanifest.json',
      '/api/files/raw?path=.forgeax%2Fgames%2Fmarket%2Fvisual-priors%2Fmarket-night.jpg',
    ]);
    source.dispose();
    unregister();
  });

  test('reports whether the active game has a prior catalog', async () => {
    const unregister = registerEditorVisualHost({
      gateway: {
        activeWorld: {} as never,
        mode: 'play',
        subscribe: () => () => {},
      },
      canvas: {} as HTMLCanvasElement,
      gameRoot: '.forgeax/games/market',
      getActiveCameraEntity: () => undefined,
    });
    const source = createEditorVisualSource();
    globalThis.fetch = (async (_input: string | URL | Request) => Response.json({
      content: JSON.stringify({ version: 1, entries: [] }),
    })) as typeof fetch;

    await expect(source.hasPriorCatalog()).resolves.toBe(true);
    source.dispose();
    unregister();

    const missing = createEditorVisualSource();
    await expect(missing.hasPriorCatalog()).resolves.toBe(false);
    missing.dispose();
  });

  test('rejects unknown keys without requesting an image', async () => {
    let imageRequested = false;
    const unregister = registerEditorVisualHost({
      gateway: {
        activeWorld: {} as never,
        mode: 'play',
        subscribe: () => () => {},
      },
      canvas: {} as HTMLCanvasElement,
      gameRoot: '.forgeax/games/market',
      getActiveCameraEntity: () => undefined,
    });
    const source = createEditorVisualSource();
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input).includes('/raw?')) imageRequested = true;
      return Response.json({
        content: JSON.stringify({ version: 1, entries: [] }),
      });
    }) as typeof fetch;

    await expect(source.resolveSeedImage('missing')).rejects.toThrow(
      'No visual prior is registered for continuity key "missing"',
    );
    expect(imageRequested).toBe(false);
    source.dispose();
    unregister();
  });

  test('does not reuse a same-key prior after the game root changes', async () => {
    const manifests = new Map<string, string>();
    const registrations: Array<() => void> = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith('/api/files?')) {
        const root = decodeURIComponent(url).includes('/games/one/')
          ? 'one'
          : 'two';
        manifests.set(root, (manifests.get(root) ?? '') + 'manifest');
        return Response.json({
          content: JSON.stringify({
            version: 1,
            entries: [{ continuityKey: 'same-key', image: `${root}.jpg` }],
          }),
        });
      }
      return new Response(new Blob(['image'], { type: 'image/jpeg' }));
    }) as typeof fetch;

    registrations.push(registerEditorVisualHost({
      gateway: {
        activeWorld: {} as never,
        mode: 'play',
        subscribe: () => () => {},
      },
      canvas: {} as HTMLCanvasElement,
      gameRoot: '.forgeax/games/one',
      getActiveCameraEntity: () => undefined,
    }));
    const source = createEditorVisualSource();
    await source.resolveSeedImage('same-key');

    registrations[0]!();
    registrations.push(registerEditorVisualHost({
      gateway: {
        activeWorld: {} as never,
        mode: 'play',
        subscribe: () => () => {},
      },
      canvas: {} as HTMLCanvasElement,
      gameRoot: '.forgeax/games/two',
      getActiveCameraEntity: () => undefined,
    }));
    await source.resolveSeedImage('same-key');

    expect(manifests).toEqual(new Map([['one', 'manifest'], ['two', 'manifest']]));
    source.dispose();
    registrations[1]!();
  });

  test('resolves provider-neutral presentation prose and falls back only on a real 404', async () => {
    const unregister = registerEditorVisualHost({
      gateway: {
        activeWorld: {} as never,
        mode: 'play',
        subscribe: () => () => {},
      },
      canvas: {} as HTMLCanvasElement,
      gameRoot: '.forgeax/games/market',
      getActiveCameraEntity: () => undefined,
    });
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('visual-presentation')) {
        return Response.json({
          content: JSON.stringify({
            version: 2,
            entries: [{
              continuityKey: 'market-night',
              signals: [],
              baseline: {},
              recipes: [],
            }],
          }),
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const source = createEditorVisualSource();
    await expect(source.resolvePresentation('market-night')).resolves.toMatchObject({
      continuityKey: 'market-night',
      recipes: [],
    });
    source.dispose();
    unregister();

    const missing = createEditorVisualSource();
    await expect(missing.resolvePresentation('market-night')).resolves.toBeUndefined();
    missing.dispose();
  });

  test('fails closed when a presentation manifest exists but omits the requested key', async () => {
    const unregister = registerEditorVisualHost({
      gateway: {
        activeWorld: {} as never,
        mode: 'play',
        subscribe: () => () => {},
      },
      canvas: {} as HTMLCanvasElement,
      gameRoot: '.forgeax/games/market',
      getActiveCameraEntity: () => undefined,
    });
    globalThis.fetch = (async () => Response.json({
      content: JSON.stringify({ version: 2, entries: [] }),
    })) as unknown as typeof fetch;

    const source = createEditorVisualSource();
    await expect(source.resolvePresentation('missing')).rejects.toThrow(
      'No visual presentation is registered for continuity key "missing"',
    );
    source.dispose();
    unregister();
  });

  test('observes the atomic presentation program from the active game world', () => {
    const resources = new Map<string, unknown>([
      ['ForgeaxVisualPresentationProgram', {
        version: 1,
        revision: 3,
        creativeDirection: 'Warm sunset follows the player.',
        lifecycle: {
          desiredPlayback: 'paused',
          restartSequence: 2,
        },
        signals: {},
        activeBehaviors: [],
        journal: { nextSequence: 1, dropped: 0, entries: [] },
        operations: [],
      }],
    ]);
    const unregister = registerEditorVisualHost({
      gateway: {
        activeWorld: {
          hasResource: (key: string) => resources.has(key),
          getResource: <T>(key: string) => resources.get(key) as T,
          insertResource: () => {},
          get: () => ({ ok: false as const }),
        } as never,
        mode: 'play',
        subscribe: () => () => {},
      },
      canvas: {} as HTMLCanvasElement,
      gameRoot: '.forgeax/games/market',
      getActiveCameraEntity: () => undefined,
    });
    const source = createEditorVisualSource();

    expect(source.getSnapshot().program).toMatchObject({
      revision: 3,
      creativeDirection: 'Warm sunset follows the player.',
      lifecycle: {
        desiredPlayback: 'paused',
        restartSequence: 2,
      },
    });

    source.dispose();
    unregister();
  });
});
