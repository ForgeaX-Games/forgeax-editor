// store/persistence/play-config — the launcher-config persistence cluster:
// <game>/play-config.json read/write (UE-style "play this level"). Read by the
// GAME at boot: { mode: 'campaign' } or { mode: 'level', level: '<sceneId>' }.
//
// M2 (w7): a `createPlayConfig(deps)` DI factory. This is the CLEAN apiFetch
// injection proof (D-3 / R-6): readPlayConfig / writePlayConfig reach the backend
// ONLY through deps.apiFetch, so a headless test injects a fake that records calls
// and never touches the network (AC-02). The seam is import->deps (structural,
// allowed by plan-strategy §2 D-3); the transport body (io/api-client.ts) is
// untouched (OOS-4), and the injected value is still getApiClient().fetch in
// production, so lint-no-direct-api-fetch stays satisfied.
//
// D-8 (fan_in avoidance): lands under store/persistence/, NOT re-exported from the
// core index.ts top-level barrel — only scene-persistence.ts composes + forwards
// it (plan-strategy §2 D-8 / R-4).
//
// OOS-1 (zero behavior change): readPlayConfig / writePlayConfig / playConfigPath
// are verbatim from scene-persistence.ts; the only edits are apiFetch /
// resolveGamePath reads re-pointed at deps.
//
// Anchors:
//   (forward) plan-strategy feat-20260709-editor-large-file-di-decompose-wave2-c-domain-scen
//     plan-id; AC-02 (headless-injectable, no singleton read) + AC-07;
//     plan-strategy §7 M2 (play-config cluster split) + §2 D-3 (apiFetch via deps)
//     + D-8 (subdir landing).
//   (backward) extracted from store/scene-persistence.ts (this loop's target),
//     itself split out of store.ts by historical feat
//     feat-20260705-editor-core-engine-convergence-store-ts-decompose.
import type { ScenePersistenceContext } from '../scene-persistence';

/** The play-config launcher shape (written by the editor's PlayLauncher select,
 *  read by the game at boot). */
export interface PlayConfig { mode: 'campaign' | 'level'; level?: string; endAfter?: boolean }

/** All createPlayConfig needs: the state handle, the injected ApiClient fetch
 *  (D-3 / R-6), and the host path resolver. */
export interface PlayConfigDeps {
  readonly ctx: ScenePersistenceContext;
  readonly apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
  readonly resolveGamePath: (rel: string) => string;
}

/** The launcher-config read/write surface. */
export interface PlayConfigStore {
  readPlayConfig(): Promise<PlayConfig>;
  writePlayConfig(cfg: PlayConfig): Promise<boolean>;
}

export function createPlayConfig(deps: PlayConfigDeps): PlayConfigStore {
  const { ctx } = deps;

  function playConfigPath(): string | null {
    return ctx.currentSceneId === 'default' ? null : deps.resolveGamePath('play-config.json');
  }

  async function readPlayConfig(): Promise<PlayConfig> {
    const p = playConfigPath();
    if (!p) return { mode: 'campaign' };
    try {
      // optional=1: play-config.json is per-developer launcher state that may not
      // exist yet (default = campaign) — the flag returns 200 { exists:false }
      // instead of 404, so an absent config logs no red error.
      const r = await deps.apiFetch(`/api/files?path=${encodeURIComponent(p)}&optional=1`);
      if (r.ok) {
        const j = (await r.json()) as { content?: string };
        if (j.content) {
          const cfg = JSON.parse(j.content) as PlayConfig;
          if (cfg && (cfg.mode === 'campaign' || cfg.mode === 'level')) return cfg;
        }
      }
    } catch { /* missing → campaign */ }
    return { mode: 'campaign' };
  }

  async function writePlayConfig(cfg: PlayConfig): Promise<boolean> {
    const p = playConfigPath();
    if (!p) return false;
    try {
      const r = await deps.apiFetch('/api/files', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: p, content: JSON.stringify(cfg, null, 2) + '\n' }),
      });
      return r.ok;
    } catch { return false; }
  }

  return { readPlayConfig, writePlayConfig };
}
