// fetch-reader.ts — fetch-based project file reader for openProject (M3 w15).
//
// Reuses the edit-runtime /api/files JSON endpoint (main.tsx:416-424).
// Sends GET /api/files?path=<encoded> and extracts the `content` field.
//
// Charter mapping:
//   P4 (consistent abstraction): matches openProject reader contract,
//     (path: string) => Promise<string>. Callers swap reader implementations
//     without changing openProject logic.
//
// Anchors:
//   plan-tasks.json w15: fetch reader injection + edit-runtime wiring
//   plan-strategy D-10: fetch reader reuses existing /api/files JSON chain
//   OOS-4: fetch reader only, fs/FSA reader deferred
//   research Finding 5: edit-runtime existing /api/files JSON chain usable as reader

/**
 * Create a reader that fetches project files via the studio /api/files endpoint.
 *
 * The reader receives project-relative paths (e.g. 'forge.json',
 * 'scenes/main.pack.json') and returns their content strings.
 * The pointer (game slug) is baked into the closure so callers don't pass it
 * separately — the reader factory captures it.
 *
 * @param slug - Game slug used to construct the full file path.
 *   The reader prepends `.forgeax/games/<slug>/` to every path.
 */
export function createFetchReader(
  slug: string,
): (path: string) => Promise<string> {
  const prefix = `.forgeax/games/${slug}/`;

  return async (path: string): Promise<string> => {
    const fullPath = `${prefix}${path}`;
    const r = await fetch(
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