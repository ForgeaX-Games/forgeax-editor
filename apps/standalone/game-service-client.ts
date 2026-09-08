// Standalone game service client.
//
// The standalone host owns one game slot, so it does not need Studio's
// multi-game/session transport. It still implements the interface game
// service contract so File → New Game can exercise the same UI path and the
// backend can materialize a selected engine template into that slot.
import type { StudioDomainClients } from '@forgeax/interface/store';

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `${path} → HTTP ${response.status}`);
  return body;
}

export function createStandaloneGameClient(onActiveGameChanged?: (slug: string) => void): StudioDomainClients {
  return {
    agents: {
      async listAgents() {
        return { agents: [] };
      },
    },
    projects: {
      async getActiveProject() {
        return readJson('/api/games/active');
      },
      async setActiveProject(slug) {
      const selection = await readJson<{ activeSlug: string | null }>('/api/games/active', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
      onActiveGameChanged?.(slug);
      return selection;
      },
      subscribeActiveProject(listener) {
        void readJson<{ activeSlug: string | null }>('/api/games/active')
          .then(listener)
          .catch(() => { /* standalone has no cross-window game stream */ });
        return () => {};
      },
      async listProjects() {
        return readJson('/api/games');
      },
      async createProject(input) {
        const response = await fetch('/api/games', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        });
        const body = await response.json() as { ok?: boolean; error?: string; slug?: string; session?: { sid: string } };
        return { ok: response.ok && body.ok === true, ...body };
      },
      async linkProject() {
        throw new Error('standalone project linking is not supported');
      },
      async deleteProject() {
        throw new Error('standalone game deletion is not supported');
      },
    },
    builds: {
      async buildProject() {
        throw new Error('standalone packaging is not supported');
      },
      async pollBuildJob() {
        throw new Error('standalone packaging is not supported');
      },
      async getEngineRoots() {
        return { roots: [] };
      },
      async cleanBuilds() {
        return { totalBytes: 0, targets: [] };
      },
      async listBuildHistory() {
        return { records: [] };
      },
      async deleteBuildHistory() {
        throw new Error('standalone packaging is not supported');
      },
    },
  };
}
