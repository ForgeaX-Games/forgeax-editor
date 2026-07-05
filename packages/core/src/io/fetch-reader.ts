// fetch-reader.ts — fetch-based project file reader for openProject (M3 w15).
//
// Reuses the edit-runtime /api/files JSON endpoint. Sends GET
// /api/files?path=<encoded> and extracts the `content` field.
//
// Charter mapping:
//   P4 (consistent abstraction): matches openProject reader contract,
//     (path: string) => Promise<string>. Callers swap reader implementations
//     without changing openProject logic.
//
// LAYOUT DECOUPLING (2026-06-25): the host's on-disk games-directory convention
// no longer lives here — that was the half-built abstraction that "baked the
// convention back in" (the feedback's irony). The reader now maps game-relative
// paths through the host-injected resolveGamePath (path-resolver.ts). The host
// (edit-runtime adapter) installs the resolver at boot; the slug is captured in
// that resolver's closure, so this factory no longer needs a slug at all.
//
// Anchors:
//   plan-tasks.json w15: fetch reader injection + edit-runtime wiring
//   plan-strategy D-10: fetch reader reuses existing /api/files JSON chain
//   OOS-4: fetch reader only, fs/FSA reader deferred
//   research Finding 5: edit-runtime existing /api/files JSON chain usable as reader

import { getApiClient } from './api-client';
import { resolveGamePath } from '../util/path-resolver';

/**
 * Create a reader that fetches project files via the studio /api/files endpoint.
 *
 * The reader receives project-relative paths (e.g. 'forge.json',
 * 'scenes/main.pack.json') and returns their content strings. Paths are mapped
 * to host locations via resolveGamePath — the reader is layout-agnostic.
 */
export function createFetchReader(): (path: string) => Promise<string> {
  return async (path: string): Promise<string> => {
    const fullPath = resolveGamePath(path);
    const r = await getApiClient().fetch(
      `/api/files?path=${encodeURIComponent(fullPath)}`,
      { cache: 'no-store' },
    );
    if (!r.ok) {
      throw new Error(`HTTP ${r.status} reading ${fullPath}`);
    }
    const j = (await r.json()) as { content?: string };
    if (!j.content) {
      throw new Error(`Empty content for ${fullPath}`);
    }
    return j.content;
  };
}