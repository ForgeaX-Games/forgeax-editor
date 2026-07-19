// pack-validation.test.ts — M1 TDD red phase: read rejection + schemaVersion dual-accept
//
// feat-20260705-editor-data-seam-hardening M1 / w1 (RED)
//
// AC-01: read rejection — malformed packs (HTTP error page, empty, truncated,
// missing schemaVersion, kind mismatch, assets non-array, entries missing
// guid/kind/refs) are all rejected with a structured error signal (not null/void).
// AC-01: schemaVersion '1.0' (editor createPack default) and '1.0.0' (engine
// serializeSceneAssetToPack output) both pass — only typeof === 'string' is checked.
// AC-05: payload: unknown transparent passthrough.
//
// requirements §7 boundary table, Finding #7 (dual schemaVersion values).
// plan-strategy D-1/D-3, charter P3 (explicit failure signal).

import { describe, expect, it } from 'bun:test';
import { validatePackShell, PackShellValidationError } from '../scene/scene-pack';

// ── Helpers ────────────────────────────────────────────────────────────────────

/** A minimal valid pack (schemaVersion '1.0', kind 'internal-text-package',
 *  one asset with guid/kind/refs and payload:null). */
function validPack(overrides?: Record<string, unknown>): Record<string, unknown> {
  const base = {
    schemaVersion: '1.0',
    kind: 'internal-text-package',
    assets: [
      {
        guid: '550e8400-e29b-41d4-a716-446655440000',
        kind: 'scene',
        refs: [],
        payload: null,
      },
    ],
  };
  if (!overrides) return base;
  return { ...base, ...overrides } as Record<string, unknown>;
}

// ── w1: Read rejection tests (RED — validatePackShell not defined yet) ─────────

describe('M1/w1: read-pack rejection (AC-01, requirements §7 boundary table)', () => {
  // ── Non-JSON / malformed content ────────────────────────────────────────────

  it('rejects HTTP error page text (non-JSON)', () => {
    const result = validatePackShell('<html><body>502 Bad Gateway</body></html>');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(PackShellValidationError);
    }
  });

  it('rejects empty string', () => {
    const result = validatePackShell('');
    expect(result.ok).toBe(false);
  });

  it('rejects truncated JSON', () => {
    const result = validatePackShell('{"schemaVersion":"1.0","kind":"internal-text-package","assets":[{"guid":"x"');
    expect(result.ok).toBe(false);
  });

  // ── Missing required top-level fields ───────────────────────────────────────

  it('rejects pack missing schemaVersion', () => {
    const obj = validPack();
    delete (obj as Record<string, unknown>).schemaVersion;
    const result = validatePackShell(obj);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(PackShellValidationError);
    }
  });

  it('rejects pack with non-string schemaVersion', () => {
    const obj = validPack({ schemaVersion: 123 });
    const result = validatePackShell(obj);
    expect(result.ok).toBe(false);
  });

  // ── kind validation ─────────────────────────────────────────────────────────

  it('rejects pack missing kind', () => {
    const obj = validPack();
    delete (obj as Record<string, unknown>).kind;
    const result = validatePackShell(obj);
    expect(result.ok).toBe(false);
  });

  it('rejects pack with wrong kind (not "internal-text-package")', () => {
    const obj = validPack({ kind: 'scene-pack-v2' });
    const result = validatePackShell(obj);
    expect(result.ok).toBe(false);
  });

  // ── assets validation ───────────────────────────────────────────────────────

  it('rejects pack with assets not an array', () => {
    const obj = validPack({ assets: 'not-an-array' });
    const result = validatePackShell(obj);
    expect(result.ok).toBe(false);
  });

  it('rejects pack with assets null', () => {
    const obj = validPack({ assets: null });
    const result = validatePackShell(obj);
    expect(result.ok).toBe(false);
  });

  it('rejects pack missing assets', () => {
    const obj = validPack();
    delete (obj as Record<string, unknown>).assets;
    const result = validatePackShell(obj);
    expect(result.ok).toBe(false);
  });

  // ── Per-entry validation ────────────────────────────────────────────────────

  it('rejects asset entry missing guid', () => {
    const obj = validPack();
    (obj as Record<string, unknown>).assets = [
      { kind: 'scene', refs: [], payload: null },
    ];
    const result = validatePackShell(obj);
    expect(result.ok).toBe(false);
  });

  it('rejects asset entry missing kind', () => {
    const obj = validPack();
    (obj as Record<string, unknown>).assets = [
      { guid: '550e8400-e29b-41d4-a716-446655440000', refs: [], payload: null },
    ];
    const result = validatePackShell(obj);
    expect(result.ok).toBe(false);
  });

  it('rejects asset entry missing refs', () => {
    const obj = validPack();
    (obj as Record<string, unknown>).assets = [
      { guid: '550e8400-e29b-41d4-a716-446655440000', kind: 'scene', payload: null },
    ];
    const result = validatePackShell(obj);
    expect(result.ok).toBe(false);
  });

  it('rejects asset entry with non-string guid', () => {
    const obj = validPack();
    (obj as Record<string, unknown>).assets = [
      { guid: 123, kind: 'scene', refs: [], payload: null },
    ];
    const result = validatePackShell(obj);
    expect(result.ok).toBe(false);
  });

  it('rejects asset entry with non-string-array refs', () => {
    const obj = validPack();
    (obj as Record<string, unknown>).assets = [
      { guid: 'g1', kind: 'scene', refs: 'not-array', payload: null },
    ];
    const result = validatePackShell(obj);
    expect(result.ok).toBe(false);
  });
});

// ── w1: schemaVersion dual-accept tests (AC-01, Finding #7) ────────────────────

describe('M1/w1: schemaVersion dual-accept (AC-01, Finding #7)', () => {
  it('accepts schemaVersion "1.0" (editor createPack default)', () => {
    const result = validatePackShell(validPack({ schemaVersion: '1.0' }));
    expect(result.ok).toBe(true);
  });

  it('accepts schemaVersion "1.0.0" (engine serializeSceneAssetToPack output)', () => {
    const result = validatePackShell(validPack({ schemaVersion: '1.0.0' }));
    expect(result.ok).toBe(true);
  });

  it('accepts schemaVersion as any string (typeof check only, not value-locked)', () => {
    const result = validatePackShell(validPack({ schemaVersion: '2.0.0-beta.1' }));
    expect(result.ok).toBe(true);
  });

  it('accepts empty string schemaVersion (typeof === "string" is the only guard)', () => {
    const result = validatePackShell(validPack({ schemaVersion: '' }));
    expect(result.ok).toBe(true);
  });
});

// ── w1: payload transparent passthrough (AC-05) ────────────────────────────────

describe('M1/w1: payload unknown transparent passthrough (AC-05)', () => {
  it('accepts pack with payload: null', () => {
    const result = validatePackShell(validPack());
    expect(result.ok).toBe(true);
  });

  it('accepts pack with payload: empty object', () => {
    const obj = validPack();
    (obj as Record<string, unknown>).assets = [
      { guid: 'g1', kind: 'scene', refs: [], payload: {} },
    ];
    const result = validatePackShell(obj);
    expect(result.ok).toBe(true);
  });

  it('accepts pack with payload of arbitrary kind', () => {
    const obj = validPack();
    (obj as Record<string, unknown>).assets = [
      { guid: 'g1', kind: 'custom-plugin', refs: [], payload: { version: 3, data: 'binary' } },
    ];
    const result = validatePackShell(obj);
    expect(result.ok).toBe(true);
  });
});

// ── w1: valid pack passes ─────────────────────────────────────────────────────

describe('M1/w1: valid packs pass validation', () => {
  it('accepts a minimal valid pack with a single scene asset', () => {
    const result = validatePackShell(validPack());
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The returned pack is the original object, not a zod parse product
      expect(result.pack.schemaVersion).toBe('1.0');
      expect(result.pack.kind).toBe('internal-text-package');
      expect(result.pack.assets).toHaveLength(1);
    }
  });

  it('accepts a valid pack with multiple assets of different kinds', () => {
    const obj = {
      schemaVersion: '1.0.0',
      kind: 'internal-text-package',
      assets: [
        { guid: 'g-scene', kind: 'scene', refs: ['g-mat', 'g-mesh'], payload: { entities: [] } },
        { guid: 'g-mat', kind: 'material', refs: [], payload: { passes: [] } },
        { guid: 'g-mesh', kind: 'mesh', refs: [], payload: null, name: 'Cube' },
      ],
    };
    const result = validatePackShell(obj);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pack.assets).toHaveLength(3);
    }
  });

  it('accepts a pack with an empty assets array', () => {
    const obj = validPack({ assets: [] });
    const result = validatePackShell(obj);
    expect(result.ok).toBe(true);
  });
});

// ── w1: structured failure signal (not null/void/catch-swallow) ───────────────

describe('M1/w1: structured failure signal (charter P3)', () => {
  it('returns { ok: false, error } shape for a bad pack (not null)', () => {
    const result = validatePackShell('not-json');
    // NOT null — must be a structured Result
    expect(result).not.toBeNull();
    expect(typeof result).toBe('object');
    expect('ok' in result).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeDefined();
      expect(result.error).toBeInstanceOf(PackShellValidationError);
    }
  });

  it('does not throw on invalid input (Result return, not throw)', () => {
    // validatePackShell must not throw — it returns Result (plan-strategy D-3)
    let threw = false;
    try {
      validatePackShell(null);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
// w2: write rejection + round-trip fidelity + error attributes (RED)
// ═══════════════════════════════════════════════════════════════════════════════════
//
// AC-02: write rejection — bad pack is rejected, original file unchanged, structured error returned.
// AC-02: serializedPack() returns null → abort write (existing protection preserved).
// AC-03: error attributes — code (UPPER_SNAKE literal), hint (actionable recovery),
//   expected (shape description), issues (field-level ZodIssue[]) — all machine-readable.
// AC-05: payload: unknown transparent passthrough.
// R-zodstrip (plan-strategy §4): pack with unknown extra fields round-trips with bytes
//   intact — zod safeParse is used as a predicate only, the original JSON.parse object
//   is returned (validator-not-transformer, D-1).
// charter P3: error consumed via attribute access, not string parsing; message is human-only.

// ── w2: Write rejection (AC-02) ──────────────────────────────────────────────────

describe('M1/w2: write rejection (AC-02)', () => {
  it('rejects a bad pack — validatePackShell returns ok:false', () => {
    const badPack = validPack({ kind: 'wrong-kind' });
    const result = validatePackShell(badPack);
    expect(result.ok).toBe(false);
  });

  it('rejects a pack with an asset entry missing guid (would corrupt on write)', () => {
    const obj = validPack();
    (obj as Record<string, unknown>).assets = [
      { kind: 'scene', refs: [], payload: null },
    ];
    const result = validatePackShell(obj);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Structured error is returned — not swallowed
      expect(result.error).toBeInstanceOf(PackShellValidationError);
    }
  });

  it('write-side rejection returns structured error (not null/false/void)', () => {
    const result = validatePackShell({});
    // Structured signal, not bare null
    expect(result).not.toBeNull();
    expect(typeof result).toBe('object');
    expect('ok' in result).toBe(true);
    if (!result.ok) {
      expect(result.error).toBeDefined();
    }
  });
});

// ── w2: Round-trip byte fidelity (R-zodstrip, plan-strategy D-1) ─────────────────

describe('M1/w2: round-trip byte fidelity (R-zodstrip, D-1)', () => {
  it('pack with unknown extra fields survives round-trip with bytes intact', () => {
    // Construct a valid pack with an extra field NOT in the zod schema.
    // The validator must NOT strip it — safeParse is a predicate, not a transformer.
    const obj = validPack();
    (obj as Record<string, unknown>).extraPluginField = { version: 42, enabled: true };
    (obj as Record<string, unknown>).__internalMeta = 'some-plugin-data';

    const result = validatePackShell(obj);
    expect(result.ok).toBe(true);

    // The returned pack must be the SAME object (reference equality or at least
    // carry the extra fields). D-1: validator-not-transformer.
    if (result.ok) {
      expect((result.pack as Record<string, unknown>).extraPluginField).toEqual({ version: 42, enabled: true });
      expect((result.pack as Record<string, unknown>).__internalMeta).toBe('some-plugin-data');
    }
  });

  it('pack with extra field on asset entry also preserved', () => {
    const obj = validPack();
    const entry = (obj as Record<string, unknown>).assets as Array<Record<string, unknown>>;
    entry[0]!._customField = 'preserved';
    entry[0]!.extraFlag = true;

    const result = validatePackShell(obj);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const a = (result.pack as Record<string, unknown>).assets as Array<Record<string, unknown>>;
      expect(a[0]!._customField).toBe('preserved');
      expect(a[0]!.extraFlag).toBe(true);
    }
  });

  it('round-trip: serialize → validate → re-serialize produces identical JSON', () => {
    const obj = validPack({ schemaVersion: '1.0.0' });
    (obj as Record<string, unknown>).extra = 'survives';
    const originalJson = JSON.stringify(obj);

    const result = validatePackShell(obj);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const roundTripJson = JSON.stringify(result.pack);
      expect(roundTripJson).toBe(originalJson);
    }
  });
});

// ── w2: Error attribute assertions (AC-03, charter P3) ───────────────────────────

describe('M1/w2: error attributes (AC-03, charter P3)', () => {
  it('PackShellValidationError has .code (UPPER_SNAKE literal)', () => {
    const result = validatePackShell({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(PackShellValidationError);
      expect(typeof result.error.code).toBe('string');
      // code is UPPER_SNAKE per plan D-2
      expect(result.error.code).toMatch(/^[A-Z][A-Z_]+$/);
      // Not the VAG_SCHEMA_MISMATCH code — pack domain has its own
      expect(result.error.code).not.toBe('VAG_SCHEMA_MISMATCH');
    }
  });

  it('PackShellValidationError has .hint (actionable recovery hint)', () => {
    const result = validatePackShell({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.error.hint).toBe('string');
      expect(result.error.hint.length).toBeGreaterThan(0);
    }
  });

  it('PackShellValidationError has .expected (shape description)', () => {
    const result = validatePackShell({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // expected is string or object (aligns with VagMessageError)
      expect(['string', 'object']).toContain(typeof result.error.expected);
    }
  });

  it('PackShellValidationError has .issues (ZodIssue[] for field-level diagnostics)', () => {
    const result = validatePackShell({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Array.isArray(result.error.issues)).toBe(true);
      // At least one issue for the completely empty object
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  it('error.message exists but is human-readable (charter P3: message is human-only)', () => {
    const result = validatePackShell({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.error.message).toBe('string');
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });

  it('error properties are consumed via attribute access, not string parsing', () => {
    // charter P3: AI users access .code, .hint, .expected, .issues directly
    const result = validatePackShell({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.error;
      // All four properties accessible without error
      const code: string = err.code;
      const hint: string = err.hint;
      const expected: string | object = err.expected;
      const issues: unknown[] = err.issues;
      // TS: these should compile without cast
      expect(typeof code).toBe('string');
      expect(typeof hint).toBe('string');
      expect(Array.isArray(issues)).toBe(true);
    }
  });

  it('error for a specific field failure names the field in issues', () => {
    // Missing schemaVersion should produce an issue referencing schemaVersion
    const result = validatePackShell({ kind: 'internal-text-package', assets: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const hasSchemaVersionIssue = result.error.issues.some(
        (i: { path: (string | number)[] }) =>
          i.path.includes('schemaVersion'),
      );
      expect(hasSchemaVersionIssue).toBe(true);
    }
  });
});