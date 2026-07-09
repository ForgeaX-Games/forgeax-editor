// editor-import-error.ts — structured import/probe error taxonomy for the edit
// surface, extracted from EditSurface.tsx (M5 / w16).
//
// ── What lives here (and why it is ONE cohesive unit) ────────────────────────
//   EditorImportErrorCode  — the stable enum an AI user branches on.
//   ERROR_HINTS            — code -> { hint, expected } table (the taxonomy body).
//   EditorImportError      — an Error subclass carrying code/hint/expected AS
//                            PROPERTIES, so recovery reads fields, never parses
//                            the message string (charter P3 / AC-09).
//   ProbeResult / probeServer — the mount-time server probe that PRODUCES an
//                            EditorImportError('SERVER_UNAVAILABLE') on failure.
// The probe and the error taxonomy it emits are the same concept — "is the
// backend reachable, and if not, say so structurally" — so they move together.
// EditSurface.tsx re-exports these to preserve its published `/surface` face
// (src/edit.ts re-exports EditorImportError + EditorImportErrorCode from it).
//
// This module is convention-free and side-effect-free at import time: it touches
// the backend only through editor-core's same-origin `apiFetch`, so it is unit-
// testable headlessly by overriding globalThis.fetch (see
// __tests__/editor-import-error.test.ts).
//
// ── Anchors (AC-07, bidirectional) ───────────────────────────────────────────
// FORWARD  → this loop: feat-20260709-editor-large-file-di-decompose-wave2-c-
//            domain-scen, M5 w16; requirements AC-09 (structured error consumed
//            via property access) + AC-08 (edit-runtime EditSurface.tsx LOC down)
//            + AC-07 (bidirectional header anchor); plan-strategy §2 D-7 (AC-09
//            movable surface narrowed to EditorImportError only — scene-pack's
//            PackShellValidationError stays put) + §8.error-info (structured
//            props preserved to serve AI property-access recovery).
// BACKWARD → EditSurface.tsx origin: the probe + EditorImportError landed in the
//            data/backend-seam hardening batch A (#44, feat "data/backend-seam
//            hardening batch A — pack schema validation + ApiClient downgraded to
//            apiFetch"), where serverBase was retired for same-origin apiFetch (D-7).
// charter P3 (explicit structured failure — code/hint/expected).

import { apiFetch } from '@forgeax/editor-core';

// ── EditorImportError ────────────────────────────────────────────────────────

export type EditorImportErrorCode = 'SERVER_UNAVAILABLE' | 'UNKNOWN';

const ERROR_HINTS: Record<EditorImportErrorCode, { hint: string; expected: string }> = {
  SERVER_UNAVAILABLE: {
    hint: 'The forgeax server (:18900) is not reachable from this host. Asset import and workbench features will be disabled. Start the server with `bash start.sh` in the forgeax-studio root.',
    expected: 'A running forgeax server reachable at the same-origin /api endpoint.',
  },
  UNKNOWN: {
    hint: 'An unexpected error occurred during the server probe.',
    expected: 'A valid response from the server probe endpoint.',
  },
};

export class EditorImportError extends Error {
  code: EditorImportErrorCode;
  hint: string;
  expected: string;

  constructor(code: EditorImportErrorCode) {
    const info = ERROR_HINTS[code];
    super(`EditorImportError: ${code} — ${info.hint}`);
    this.name = 'EditorImportError';
    this.code = code;
    this.hint = info.hint;
    this.expected = info.expected;
  }
}

// ── probeServer ────────────────────────────────────────────────────────────────

export interface ProbeResult {
  available: boolean;
  slug?: string | null;
  error?: EditorImportError;
}

export async function probeServer(): Promise<ProbeResult> {
  try {
    const r = await apiFetch('/api/workbench/active-slug');
    if (!r.ok) {
      return {
        available: false,
        error: new EditorImportError('SERVER_UNAVAILABLE'),
      };
    }
    const j = (await r.json()) as { activeSlug?: string | null };
    return { available: true, slug: j.activeSlug ?? null };
  } catch {
    return {
      available: false,
      error: new EditorImportError('SERVER_UNAVAILABLE'),
    };
  }
}
