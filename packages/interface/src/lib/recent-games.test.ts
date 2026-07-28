import { describe, expect, test } from 'bun:test';
import {
  getRecentGames,
  getRecentGamesRevision,
  subscribeRecentGames,
  warmRecentGames,
} from './recent-games';
import { configureWorkbenchClient, type WorkbenchClient } from '../store-parts/workbench-client';

describe('recent games cache', () => {
  test('notifies the menu after async games arrive and sorts by mtime', async () => {
    configureWorkbenchClient({
      listGames: async () => ({
        games: [
          { slug: 'older', mtime: 10 },
          { slug: 'newer', mtime: 20 },
        ],
        activeSlug: null,
      }),
    } as WorkbenchClient);

    const before = getRecentGamesRevision();
    let notifications = 0;
    const unsubscribe = subscribeRecentGames(() => { notifications += 1; });
    await warmRecentGames();
    unsubscribe();

    expect(getRecentGamesRevision()).toBe(before + 1);
    expect(notifications).toBe(1);
    expect(getRecentGames().map((game) => game.slug)).toEqual(['newer', 'older']);
  });
});
