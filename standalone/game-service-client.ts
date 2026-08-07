// Standalone game service client.
//
// The standalone host owns one game slot, so it does not need Studio's
// multi-game/session transport. It still implements the interface game
// service contract so File → New Game can exercise the same UI path and the
// backend can materialize a selected engine template into that slot.
import type { WorkbenchClient } from '@forgeax/interface/store';

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `${path} → HTTP ${response.status}`);
  return body;
}

export function createStandaloneGameClient(onActiveGameChanged?: (slug: string) => void): WorkbenchClient {
  return {
    async listAgents() {
      return { agents: [] };
    },
    async getActiveGame() {
      return readJson('/api/games/active');
    },
    async setActiveGame(slug) {
      const selection = await readJson<{ activeSlug: string | null }>('/api/games/active', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
      onActiveGameChanged?.(slug);
      return selection;
    },
    subscribeActiveGame(listener) {
      void readJson<{ activeSlug: string | null }>('/api/games/active')
        .then(listener)
        .catch(() => { /* standalone has no cross-window game stream */ });
      return () => {};
    },
    async listGames() {
      return readJson('/api/games');
    },
    async createGame(input) {
      const response = await fetch('/api/games', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      const body = await response.json() as { ok?: boolean; error?: string };
      return { ok: response.ok && body.ok === true, error: body.error };
    },
    async deleteGame() {
      throw new Error('standalone game deletion is not supported');
    },
    async packageGame() {
      throw new Error('standalone packaging is not supported');
    },
    async pollPackageJob() {
      throw new Error('standalone packaging is not supported');
    },
    async getEngineRoots() {
      return { roots: [] };
    },
    async cleanPackage() {
      return { totalBytes: 0, targets: [] };
    },
    async listPackageHistory() {
      return { records: [] };
    },
    async deletePackageHistory() {
      throw new Error('standalone packaging is not supported');
    },
  };
}
