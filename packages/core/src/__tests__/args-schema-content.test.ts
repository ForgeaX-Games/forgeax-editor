// args-schema-content.test.ts — content-validation branches added by
// 2026-07-23 args-schema-pattern-content-validation.dev-plan.md (follow-up
// PR-B1 of §7.1 方案 B). Extends the base type/required/enum/items validator
// (see args-schema-validator.test.ts) with:
//   - string pattern (safe subset only) + patternHint
//   - string minLength / maxLength
//   - number minimum / maximum
//
// The safe-pattern compiler is ReDoS-defensive: an unsafe catalog author-time
// regex (e.g. `(a+)+`) must be REJECTED — surface as an `internal:` message
// so tests catch it without crashing dispatch.

import { describe, expect, it } from 'bun:test';
import { validate } from '../io/args-schema';

// ── pattern ────────────────────────────────────────────────────────────────

describe('pattern (string content regex)', () => {
  it('accepts a string matching the pattern', () => {
    const r = validate({ type: 'string', pattern: '^[a-z]+$' }, 'abc');
    expect(r.ok).toBe(true);
  });

  it('rejects a string not matching the pattern', () => {
    const r = validate({ type: 'string', pattern: '^[a-z]+$' }, 'ABC');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toMatch(/pattern/);
  });

  it('uses patternHint verbatim when supplied (human-readable failure)', () => {
    const r = validate(
      {
        type: 'string',
        pattern: '^[a-z]+$',
        patternHint: 'must be all lowercase letters',
      },
      'ABC',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toBe('must be all lowercase letters');
  });

  it('never echoes the raw pattern in the default failure message', () => {
    const r = validate({ type: 'string', pattern: '^[a-z]+$' }, 'ABC');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Default message is "does not match required pattern" — no regex leak.
      expect(r.errors[0]!.message).not.toContain('^[a-z]+$');
      expect(r.errors[0]!.message).not.toContain('[a-z]');
    }
  });

  it('does not run pattern for non-string types (defensive)', () => {
    const r = validate({ type: 'number', pattern: '^[0-9]+$' }, 42);
    expect(r.ok).toBe(true);
  });
});

describe('pattern — folder-basename SSOT regex (the reported bug application)', () => {
  const schema = {
    type: 'string' as const,
    pattern: '^[^\\\\/:*?"<>|\\x00-\\x1f]+$',
    patternHint:
      'contains an illegal character (not allowed: \\ / : * ? " < > | or control chars)',
    minLength: 1,
    maxLength: 255,
  };

  it('accepts a legal basename', () => {
    expect(validate(schema, 'textures').ok).toBe(true);
    expect(validate(schema, '模型-fbx').ok).toBe(true);
    expect(validate(schema, 'foo (2)').ok).toBe(true);
  });

  it('rejects "foo\\bar" (the exact reported bug)', () => {
    const r = validate(schema, 'foo\\bar');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toContain('illegal character');
  });

  it('rejects each of the 9 filesystem-illegal characters', () => {
    for (const ch of ['\\', '/', ':', '*', '?', '"', '<', '>', '|']) {
      expect(validate(schema, `foo${ch}bar`).ok).toBe(false);
    }
  });

  it('rejects control chars (NUL through US)', () => {
    expect(validate(schema, 'foo\x00bar').ok).toBe(false);
    expect(validate(schema, 'foo\x1fbar').ok).toBe(false);
    expect(validate(schema, 'foo\tbar').ok).toBe(false);
  });

  it('rejects empty (minLength)', () => {
    const r = validate(schema, '');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toMatch(/too short/);
  });

  it('rejects too-long (maxLength)', () => {
    const r = validate(schema, 'a'.repeat(256));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toMatch(/too long/);
  });
});

// ── safe-pattern compilation (ReDoS defense) ────────────────────────────

describe('_compilePattern (safe subset)', () => {
  it('rejects a lookbehind pattern (?<= …)', () => {
    const r = validate({ type: 'string', pattern: '(?<=a)b' }, 'ab');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toMatch(/internal/);
  });

  it('rejects a lookahead pattern (?= …)', () => {
    const r = validate({ type: 'string', pattern: 'a(?=b)' }, 'ab');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toMatch(/internal/);
  });

  it('rejects a negative lookahead (?! …)', () => {
    const r = validate({ type: 'string', pattern: 'a(?!b)' }, 'ac');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toMatch(/internal/);
  });

  it('rejects a backreference \\1', () => {
    const r = validate({ type: 'string', pattern: '(a)\\1' }, 'aa');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toMatch(/internal/);
  });

  it('rejects "(a+)+" (group with quantifier — classic ReDoS shape)', () => {
    const r = validate({ type: 'string', pattern: '(a+)+' }, 'aaa');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toMatch(/internal/);
  });

  it('rejects "(a|b)+" (unbounded alternation with quantifier)', () => {
    const r = validate({ type: 'string', pattern: '(a|b)+' }, 'ab');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toMatch(/internal/);
  });

  it('rejects a syntactically invalid regex "["', () => {
    const r = validate({ type: 'string', pattern: '[' }, 'a');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toMatch(/internal/);
  });

  it('CACHES compilation — invoking the same pattern twice does not recompile (behavior invariant, not observable timing)', () => {
    // Cache is internal; assert observable behavior: two calls yield identical
    // pass/fail plus identical error text. Bug in the cache would swap results.
    const s = { type: 'string' as const, pattern: '^[a-z]+$' };
    const a = validate(s, 'abc');
    const b = validate(s, 'abc');
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const c = validate(s, 'X');
    const d = validate(s, 'X');
    expect(c.ok).toBe(false);
    expect(d.ok).toBe(false);
    if (!c.ok && !d.ok) expect(c.errors[0]!.message).toBe(d.errors[0]!.message);
  });
});

// ── minLength / maxLength ────────────────────────────────────────────────

describe('minLength / maxLength (string only)', () => {
  it('accepts a string at minLength boundary', () => {
    expect(validate({ type: 'string', minLength: 3 }, 'abc').ok).toBe(true);
  });
  it('rejects a string shorter than minLength', () => {
    const r = validate({ type: 'string', minLength: 3 }, 'ab');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toMatch(/too short.*3.*got 2/);
  });
  it('accepts a string at maxLength boundary', () => {
    expect(validate({ type: 'string', maxLength: 3 }, 'abc').ok).toBe(true);
  });
  it('rejects a string longer than maxLength', () => {
    const r = validate({ type: 'string', maxLength: 3 }, 'abcd');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toMatch(/too long.*3.*got 4/);
  });
  it('accepts an EXACT-length string when min===max', () => {
    expect(validate({ type: 'string', minLength: 36, maxLength: 36 }, 'a'.repeat(36)).ok).toBe(true);
    expect(validate({ type: 'string', minLength: 36, maxLength: 36 }, 'a'.repeat(35)).ok).toBe(false);
    expect(validate({ type: 'string', minLength: 36, maxLength: 36 }, 'a'.repeat(37)).ok).toBe(false);
  });
  it('does not apply length limits to non-string types', () => {
    expect(validate({ type: 'number', minLength: 5 }, 3).ok).toBe(true);
  });
});

// ── minimum / maximum (number only) ──────────────────────────────────────

describe('minimum / maximum (number only)', () => {
  it('accepts a value inside [min, max]', () => {
    expect(validate({ type: 'number', minimum: 0, maximum: 1 }, 0.5).ok).toBe(true);
  });
  it('accepts boundary values (INCLUSIVE)', () => {
    expect(validate({ type: 'number', minimum: 0, maximum: 1 }, 0).ok).toBe(true);
    expect(validate({ type: 'number', minimum: 0, maximum: 1 }, 1).ok).toBe(true);
  });
  it('rejects below minimum', () => {
    const r = validate({ type: 'number', minimum: 0 }, -0.1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toMatch(/below minimum.*0.*got -0.1/);
  });
  it('rejects above maximum', () => {
    const r = validate({ type: 'number', maximum: 1 }, 1.1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toMatch(/above maximum.*1.*got 1.1/);
  });
  it('nullable + minimum: null passes (short-circuit before content check)', () => {
    const r = validate({ type: 'number', minimum: 0, nullable: true }, null);
    expect(r.ok).toBe(true);
  });
  it('does not apply numeric range to non-number types', () => {
    expect(validate({ type: 'string', minimum: 5 }, 'abc').ok).toBe(true);
  });
});

// ── property-nested content validation (path reporting) ────────────────

describe('nested content validation reports the property path', () => {
  const schema = {
    type: 'object' as const,
    properties: {
      name: { type: 'string' as const, pattern: '^[a-z]+$', patternHint: 'lowercase letters only' },
    },
    required: ['name'],
  };
  it('reports "name" as the failing path (not "(root)")', () => {
    const r = validate(schema, { name: 'ABC' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]!.path).toBe('name');
      expect(r.errors[0]!.message).toBe('lowercase letters only');
    }
  });
});

// ── regression: existing base validator still works ────────────────────

describe('regression: base validator branches unaffected', () => {
  it('missing required field still rejected', () => {
    const r = validate(
      { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
      {},
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toMatch(/required/);
  });

  it('nullable field still accepts null', () => {
    const r = validate({ type: 'number', nullable: true }, null);
    expect(r.ok).toBe(true);
  });

  it('enum still enforced', () => {
    const r = validate({ type: 'string', enum: ['a', 'b'] }, 'c');
    expect(r.ok).toBe(false);
  });
});
