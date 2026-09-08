import { describe, expect, test } from 'bun:test';
import { importFirstGameEntry } from '../game-entry-loader';

describe('game entry loader', () => {
  test('uses module import as the availability check without an HTTP preflight', async () => {
    const requested: string[] = [];
    const loaded = { bootstrap: () => {} };

    const result = await importFirstGameEntry(['/game/main.ts'], async (url) => {
      requested.push(url);
      return loaded;
    });

    expect(result).toBe(loaded);
    expect(requested).toEqual(['/game/main.ts']);
  });

  test('tries the legacy candidate after the manifest entry import fails', async () => {
    const requested: string[] = [];
    const loaded = { bootstrap: () => {} };

    const result = await importFirstGameEntry(
      ['/game/custom.ts', '/game/main.ts'],
      async (url) => {
        requested.push(url);
        if (url.endsWith('/custom.ts')) throw new Error('missing');
        return loaded;
      },
    );

    expect(result).toBe(loaded);
    expect(requested).toEqual(['/game/custom.ts', '/game/main.ts']);
  });

  test('reports every attempted module and preserves its import failures', async () => {
    const first = new Error('first');
    const second = new Error('second');

    await expect(importFirstGameEntry(['/game/main.ts', '/game/src/main.ts'], async (url) => {
      throw url.includes('/src/') ? second : first;
    })).rejects.toMatchObject({
      message: 'game entry could not be imported; tried /game/main.ts, /game/src/main.ts',
      errors: [first, second],
    });
  });
});
