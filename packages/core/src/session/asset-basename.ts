// asset-basename.ts — SSOT for asset filesystem BASENAME validation.
//
// One rule set, consumed by:
//   1) session appliers (createDirectory / renameDirectory / renameSourceFile /
//      applyRenameAsset) — HARD gate: applier returns
//      { ok:false, error:{ code:'INVALID_ARGS', hint } } on failure so the same
//      illegal input is rejected regardless of caller (human UI, AI dispatch,
//      transaction sub-op).
//   2) UI prompt dialogs (Content Browser new-folder / rename) — SOFT gate for
//      UX: highlight the input, disable Confirm. Calls this same function so
//      there is NO second rule source (north-star §9 by construction).
//
// Rules are intentionally the intersection of Windows and POSIX so a name that
// passes here works on every filesystem the pack round-trips through. Extra
// applier-side rules (windows reserved names, trailing space/period, `.` / `..`)
// are NOT expressible as a single character class regex, so we do them here
// procedurally rather than in a catalog `pattern`.
//
// Motivating bug: entering `foo\bar` as a folder name creates a nested dir on
// Windows (mkdir splits on `\`) or a literal `foo\bar` dir on POSIX; the read
// side normalizes `\` → `/`, so the UI path never matches disk and the folder
// becomes un-deletable through the panel. See:
//   feedbacks/2026-07-23-assets-create-folder-name-validation-illegal-chars.md
//   feedbacks/2026-07-23-assets-create-folder-name-validation-illegal-chars.dev-plan.md

/** Path separators + Windows reserved chars + ASCII control chars. */
// eslint-disable-next-line no-control-regex
const INVALID_CHARS_RE = /[\\/:*?"<>|\x00-\x1f]/;

/** Windows reserved device names (case-insensitive, with or without extension). */
const WINDOWS_RESERVED_RE =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.[^.]*)?$/i;

/** Maximum basename length — POSIX NAME_MAX is 255 on most filesystems and
 *  Windows MAX_PATH constraints make longer names hazardous. */
export const ASSET_BASENAME_MAX_LENGTH = 255;

export type BasenameValidation =
  | { ok: true; name: string }
  | { ok: false; hint: string };

/**
 * Validate a filesystem BASENAME (single path segment, no separators).
 *
 * On success returns the TRIMMED name — callers should use `result.name`, not
 * the raw input, when writing to disk (this avoids trailing/leading whitespace
 * differences between what the user typed and what lands on disk).
 */
export function validateAssetBasename(raw: unknown): BasenameValidation {
  if (typeof raw !== 'string') {
    return { ok: false, hint: 'name must be a string' };
  }
  const name = raw.trim();
  if (name.length === 0) {
    return { ok: false, hint: 'name must not be empty or whitespace-only' };
  }
  if (name.length > ASSET_BASENAME_MAX_LENGTH) {
    return {
      ok: false,
      hint: `name too long (max ${ASSET_BASENAME_MAX_LENGTH} chars, got ${name.length})`,
    };
  }
  if (name === '.' || name === '..') {
    return { ok: false, hint: `name must not be "." or ".."` };
  }
  const bad = name.match(INVALID_CHARS_RE);
  if (bad) {
    const ch = bad[0];
    const code = ch.charCodeAt(0);
    const shown = code < 0x20
      ? `\\x${code.toString(16).padStart(2, '0')}`
      : ch;
    return {
      ok: false,
      hint: `name contains invalid character "${shown}" (not allowed: \\ / : * ? " < > | or control chars)`,
    };
  }
  if (WINDOWS_RESERVED_RE.test(name)) {
    return {
      ok: false,
      hint: `name "${name}" is reserved on Windows (CON, PRN, AUX, NUL, COM1-9, LPT1-9)`,
    };
  }
  // Windows filesystem silently strips trailing dots and spaces; reject to keep
  // "what you typed" == "what is on disk" invariants.
  if (name.endsWith(' ') || name.endsWith('.')) {
    return {
      ok: false,
      hint: 'name must not end with a space or "." (Windows filesystem strips them)',
    };
  }
  return { ok: true, name };
}

/**
 * Minimal path-jailbreak defender for ops that accept a `path` (not a basename).
 * Not a substitute for server-side sandboxing — belt+suspenders for the
 * client-side gateway front door. Rejects the two obvious escape vectors:
 *   - `..` segments (parent traversal)
 *   - NUL byte (fs API truncation exploits)
 *   - backslash separators (Windows path smuggling into a POSIX-normalized
 *     model — the read side normalizes `\`→`/`, so a `\` in the write path
 *     would produce a UI/disk mismatch identical to the folder-name bug)
 */
export type PathJailbreakCheck =
  | { ok: true }
  | { ok: false; hint: string };

export function checkPathNotJailbreak(path: unknown): PathJailbreakCheck {
  if (typeof path !== 'string') {
    return { ok: false, hint: 'path must be a string' };
  }
  if (path.length === 0) {
    return { ok: false, hint: 'path must not be empty' };
  }
  // eslint-disable-next-line no-control-regex
  if (path.includes('\x00')) {
    return { ok: false, hint: 'path contains NUL byte' };
  }
  if (path.includes('\\')) {
    return {
      ok: false,
      hint: 'path must use "/" separators (not "\\")',
    };
  }
  // segment-level `..` check (a substring check would falsely reject "foo..bar")
  const segments = path.split('/');
  if (segments.some((s) => s === '..')) {
    return { ok: false, hint: 'path must not contain ".." segments' };
  }
  return { ok: true };
}
