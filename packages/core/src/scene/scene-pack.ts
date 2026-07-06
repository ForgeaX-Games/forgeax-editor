// Scene pack constants + helpers.
//
// M5: sessionToPack deleted — writeback now uses the engine's rootsToSceneAsset
// + serializeSceneAssetToPack pipeline (plan-strategy D-1). isScenePack + stableGuid
// + builtin GUID constants remain for store.ts disk-watch reload + scene seeding.
//
//   { schemaVersion, kind:'internal-text-package', assets: [
//       { guid, kind:'scene',    payload:{kind:'scene', entities}, refs:[guid…] },
//       { guid, kind:'material', payload:{kind:'material', passes, paramValues}, refs:[] },
//       …
//   ] }
//
// M1: PackFile shell zod schema SSOT (plan-strategy D-1/D-4), PackShellValidationError
// (plan-strategy D-2, charter P3), validatePackShell (plan-strategy D-1/D-3).

import { z } from 'zod';

// Engine built-in mesh GUIDs (asset-registry.ts BUILTIN_MESH_GUIDS).
export const CUBE_GUID = 'cbe42beb-8975-5096-b3a1-3dda4cb4c077';
export const SPHERE_GUID = '95730fd2-9846-5f84-8658-0b3c971eb263';
// feat-20260701-editor-world-container-doc-ecs-collapse M0 / AC-16:
// CYLINDER_GUID hand-roll deleted — replaced by engine builtin HANDLE_CYLINDER(handle=6)
// (plan-strategy §2 D-6; AGENTS.md #1 anti-pattern target)

// ── PackFile shell zod schema (SSOT, plan-strategy D-1/D-4) ────────────────────
//
// AC-01: schemaVersion is z.string() — typeof check only, no value lock
//   (both '1.0' and '1.0.0' must pass — R-schemaVer, Finding #7).
// AC-05: payload is z.unknown() — transparent passthrough, no engine
//   classifyFieldSchema duplication (OOS-1).
// D-4: name is optional — union of PackAssetEntry (has name?) and PackAsset (no name).

const packAssetEntrySchema = z.object({
  guid: z.string(),
  kind: z.string(),
  refs: z.array(z.string()),
  payload: z.unknown(),
  name: z.string().optional(),
});

const packFileSchema = z.object({
  schemaVersion: z.string(),
  kind: z.literal('internal-text-package'),
  assets: z.array(packAssetEntrySchema),
});

/** Derive the authoritative PackFile TS type from the zod schema (SSOT, Derive). */
export type PackFile = z.infer<typeof packFileSchema>;

/** Legacy alias — converged onto PackFile (SSOT). */
export type ScenePack = PackFile;

/** Legacy alias — converged onto the zod-derived asset entry shape. */
type PackAsset = z.infer<typeof packAssetEntrySchema>;

// ── PackShellValidationError (plan-strategy D-2, charter P3) ──────────────────
//
// AC-03: four machine-readable attributes — code (UPPER_SNAKE, for routing),
// hint (actionable recovery), expected (shape description), issues (ZodIssue[]
// field-level diagnostics). Message is human-only (charter P3).
//
// Aligns with VagMessageError shape (protocol.ts:336): code + issues + hint + expected.
// Does NOT reuse VagMessageError — code domain is pack-specific ('PACK_SHELL_INVALID',
// not 'VAG_SCHEMA_MISMATCH'), so AI consumers route by code correctly (D-2).

export class PackShellValidationError extends Error {
  code = 'PACK_SHELL_INVALID' as const;
  issues: z.ZodIssue[];
  hint: string;
  expected: string;

  constructor(issues: z.ZodIssue[]) {
    const pathStr = issues.map((i) => i.path.join('.')).join(', ');
    super(`PACK_SHELL_INVALID: pack validation failed at [${pathStr}]`);
    this.name = 'PackShellValidationError';
    this.issues = issues;
    this.hint =
      'The pack file has an invalid shell structure. Check that schemaVersion is a string, kind is "internal-text-package", and assets is an array where each entry has guid (string), kind (string), and refs (string[]).';
    this.expected =
      'A valid pack must have: { schemaVersion: string, kind: "internal-text-package", assets: [{ guid: string, kind: string, refs: string[], payload: unknown, name?: string }] }';
  }
}

// ── validatePackShell (plan-strategy D-1/D-3) ─────────────────────────────────
//
// AC-01/AC-02: validates pack shell structure. On success, returns the original
//   parsed object (not the zod parse product — R-zodstrip, D-1: validator-not-transformer).
//   On failure, returns a structured PackShellValidationError.
// D-3: Result return (not throw) — avoids being swallowed by existing try/catch in
//   readPack/writePack (pack-ops.ts), where throw would be silently caught and
//   return null/false.

/** Result of pack shell validation. */
export type ValidatePackShellResult =
  | { ok: true; pack: PackFile }
  | { ok: false; error: PackShellValidationError };

/**
 * Validate the shell structure of a pack file object (or a JSON string).
 *
 * On success the returned `.pack` is the **original** input object (or JSON.parse
 * result), NOT the zod `.parse()` output — zod's default behavior strips unknown
 * keys, which would silently lose plugin data on round-trip (R-zodstrip).
 *
 * String input is JSON.parsed first; parse failure returns a PackShellValidationError.
 */
export function validatePackShell(raw: unknown): ValidatePackShellResult {
  let obj: unknown;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        error: new PackShellValidationError([
          {
            code: 'custom',
            path: [],
            message: 'Failed to parse input as JSON',
          } as z.ZodIssue,
        ]),
      };
    }
  } else {
    obj = raw;
  }

  const result = packFileSchema.safeParse(obj);
  if (result.success) {
    // D-1: validator-not-transformer — return the original object, not the parse
    // product. zod's .parse()/.data strips unknown keys; safeParse + original
    // object preserves them (R-zodstrip round-trip fidelity).
    return { ok: true, pack: obj as PackFile };
  }
  return { ok: false, error: new PackShellValidationError(result.error.issues) };
}

/** Deterministic UUID-shaped string from a key (stable material GUIDs across
 *  saves). FNV-1a over four salted passes → 128 bits → 8-4-4-4-12 hex, with the
 *  version nibble forced to 5 and the variant bits to 0b10xx (RFC-valid shape). */
export function stableGuid(key: string): string {
  const fnv = (s: string): number => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  };
  const hex = (n: number): string => n.toString(16).padStart(8, '0');
  const a = hex(fnv('a|' + key)), b = hex(fnv('b|' + key)), c = hex(fnv('c|' + key)), d = hex(fnv('d|' + key));
  const all = (a + b + c + d).slice(0, 32).split('');
  all[12] = '5';                                   // version 5
  all[16] = (parseInt(all[16]!, 16) & 0x3 | 0x8).toString(16); // variant 10xx
  const s = all.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/** True if a parsed JSON object passes pack shell validation (schema-derived type-guard).
 *  Delegates to validatePackShell — no longer duck-types only kind+Array.isArray(assets).
 *  (plan-strategy D-1: isScenePack downgraded to schema-derived thin type-guard.) */
export function isScenePack(obj: unknown): obj is ScenePack {
  return validatePackShell(obj).ok;
}