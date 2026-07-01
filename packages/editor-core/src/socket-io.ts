// @forgeax/editor-core — Socket (绑点) import / export / persistence
//
// Serializes the SocketDoc model (socket.ts) to the `*.socket.json` format from
// 模型绑点编辑器开发文档.md §5.1, validates on import (zod + skeleton match), and
// reads/writes the file through the same `/api/files` seam used by store.ts.

import { getApiClient } from './api-client';
import { SocketDocSchema, type SocketDoc } from './socket';

/** Result of parsing/importing a `*.socket.json` payload. */
export type SocketImportResult =
  | { ok: true; doc: SocketDoc; warnings: string[] }
  | { ok: false; error: string };

/** Serialize a SocketDoc to pretty JSON (stable 2-space indent). */
export function exportSocketJson(doc: SocketDoc): string {
  return JSON.stringify(doc, null, 2);
}

/**
 * Parse + validate a `*.socket.json` string into a SocketDoc.
 * Soft checks (skeleton mismatch, unknown bones) are returned as `warnings`,
 * never hard failures — the user may have loaded a different but compatible rig.
 */
export function importSocketJson(
  text: string,
  opts?: { skeletonId?: string; boneNames?: readonly string[] },
): SocketImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
  }

  const parsed = SocketDocSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.join('.') || '(root)';
    return { ok: false, error: `Schema error at ${where}: ${first?.message ?? 'unknown'}` };
  }

  const doc = parsed.data;
  const warnings = validateSocketDoc(doc, opts);
  return { ok: true, doc, warnings };
}

/**
 * Non-fatal validation: returns human-readable warnings for skeleton mismatch
 * and bones that don't exist on the loaded character.
 */
export function validateSocketDoc(
  doc: SocketDoc,
  opts?: { skeletonId?: string; boneNames?: readonly string[] },
): string[] {
  const warnings: string[] = [];

  if (opts?.skeletonId && doc.skeletonId && opts.skeletonId !== doc.skeletonId) {
    warnings.push(
      `Skeleton mismatch: data was authored for "${doc.skeletonId}" but the loaded character is "${opts.skeletonId}". Values may not align.`,
    );
  }

  if (opts?.boneNames && opts.boneNames.length > 0) {
    const known = new Set(opts.boneNames);
    for (const s of doc.sockets) {
      if (!known.has(s.bone)) {
        warnings.push(`Socket "${s.id}" references unknown bone "${s.bone}".`);
      }
      for (const aux of s.aux ?? []) {
        if (!known.has(aux.bone)) {
          warnings.push(`Aux "${aux.id}" of socket "${s.id}" references unknown bone "${aux.bone}".`);
        }
      }
    }
  }

  const ids = doc.sockets.map((s) => s.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  for (const id of new Set(dupes)) {
    warnings.push(`Duplicate socket id "${id}".`);
  }

  return warnings;
}

// ── Persistence (via /api/files, mirroring store.ts) ──

/** Read + parse a `*.socket.json` from disk. Returns null if missing/unreadable. */
export async function loadSocketDoc(
  path: string,
  opts?: { skeletonId?: string; boneNames?: readonly string[] },
): Promise<SocketImportResult | null> {
  try {
    const r = await getApiClient().fetch(`/api/files?path=${encodeURIComponent(path)}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const j = (await r.json()) as { content?: string };
    if (!j.content) return null;
    return importSocketJson(j.content, opts);
  } catch {
    return null;
  }
}

/** Write a SocketDoc to disk as `*.socket.json`. Returns success. */
export async function saveSocketDoc(path: string, doc: SocketDoc): Promise<boolean> {
  try {
    const r = await getApiClient().fetch('/api/files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, content: exportSocketJson(doc) }),
    });
    return r.ok;
  } catch {
    return false;
  }
}
