// File-preview renderer registry — a module-scope registry mirroring the
// editor's established `registerBespokeEditor` / `registerEditorPreviewViewports`
// patterns. Builtins register at import time (see ./renderers/register-builtins);
// plugins register during activation. Resolution is pure: highest priority wins,
// ties resolve to the later registration.

import type { FilePreviewInput, FilePreviewRenderer } from './types';

const _renderers: FilePreviewRenderer[] = [];

/**
 * Register a preview renderer. Registration is idempotent by `id` (re-registering
 * the same id replaces the prior definition, which keeps HMR and double module
 * evaluation stable). Returns a disposer that removes exactly this registration.
 */
export function registerFilePreviewRenderer(renderer: FilePreviewRenderer): () => void {
  const existing = _renderers.findIndex((r) => r.id === renderer.id);
  if (existing >= 0) _renderers.splice(existing, 1);
  _renderers.push(renderer);
  return () => {
    const i = _renderers.indexOf(renderer);
    if (i >= 0) _renderers.splice(i, 1);
  };
}

/**
 * Resolve the winning renderer for a file, or `undefined` when none claims it
 * (the host then falls back to its generic text/binary presentation).
 */
export function resolveFilePreviewRenderer(input: FilePreviewInput): FilePreviewRenderer | undefined {
  let best: FilePreviewRenderer | undefined;
  for (const renderer of _renderers) {
    if (!renderer.match(input)) continue;
    // `>=` lets the later registration win on a priority tie.
    if (best === undefined || (renderer.priority ?? 0) >= (best.priority ?? 0)) best = renderer;
  }
  return best;
}

/** Snapshot of registered renderers — a read-only seam for tests/diagnostics. */
export function listFilePreviewRenderers(): readonly FilePreviewRenderer[] {
  return _renderers.slice();
}
