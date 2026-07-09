// Shared workspace activator — the single client entry to POST
// /api/workspaces/activate, used by BOTH the TopBar ProjectSwitcher and the
// first-run OnboardingController (project step). Keeping one copy means the two
// switch surfaces can't drift on the request shape or the pinnedSlug re-pin.
//
// The server hot-swaps FORGEAX_PROJECT_ROOT and broadcasts `workspace-changed`;
// callers are expected to `window.location.reload()` after this resolves so all
// UI state re-binds to the new root. We re-pin localStorage.pinnedSlug to the
// server-resolved activeSlug FIRST so the post-reload preview iframe lands on a
// real game rather than whatever slug the OLD workspace had pinned.

import { STORAGE_KEYS, SESSION_KEYS } from './storageKeys';
import { waitForEngineSettled } from './workspace-reload';

export interface ActivateWorkspaceInput {
  /** Absolute path (or `~/...`) of the workspace directory to activate. */
  path: string;
  /** When true (default at call sites), create the dir if missing. When false,
   *  a missing path is a hard error. */
  initIfMissing: boolean;
  /** When false, skip scaffolding a blank stub game for an empty workspace.
   *  First-run onboarding passes false — it creates its OWN named game after the
   *  root switch, so it must not inherit a junk `workspace` stub. Default true. */
  scaffold?: boolean;
}

export interface ActivateWorkspaceResult {
  ok?: boolean;
  error?: string;
  absPath?: string;
  activeSlug?: string;
  scaffolded?: boolean;
}

export async function activateWorkspace(input: ActivateWorkspaceInput): Promise<ActivateWorkspaceResult> {
  const r = await fetch('/api/workspaces/activate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      path: input.path,
      initIfMissing: input.initIfMissing,
      ...(input.scaffold === false ? { scaffold: false } : {}),
    }),
  });
  const j = (await r.json()) as ActivateWorkspaceResult;
  if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  try {
    if (j.activeSlug) localStorage.setItem(STORAGE_KEYS.pinnedSlug, j.activeSlug);
    else localStorage.removeItem(STORAGE_KEYS.pinnedSlug);
  } catch { /* ignore quota / disabled storage */ }
  // Seed the workspace-changed dedup key to the resolved root so the broadcast
  // that `activate` fanned out to THIS tab is skipped (broadcast.ts dedups on
  // equality) — the caller drives the single reload instead of racing it (005).
  try {
    if (j.absPath) sessionStorage.setItem(SESSION_KEYS.activeRoot, j.absPath);
  } catch { /* ignore quota / disabled storage */ }
  // Wait for the engine vite to finish the symlink-flip restart before the caller
  // reloads, so the post-reload preview loads exactly once against a live engine
  // (todo 005). Bounded internally, so a no-rescan switch never hangs the caller.
  await waitForEngineSettled(j.activeSlug);
  return j;
}
