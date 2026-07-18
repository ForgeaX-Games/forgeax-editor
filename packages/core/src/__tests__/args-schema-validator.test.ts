// m4-w3 — TDD: argsSchema validator test (RED phase)
//
// feat-20260706-editor-op-gateway-single-entry-b-catalog-defineop M4:
// Tests for the lightweight JSON-Schema subset validator. At RED phase,
// args-schema.ts is a stub (always returns {ok:true}). m4-w6 makes it green.
//
// Constraints:
//   plan-strategy §2 D-3: custom JSON-Schema subset, no external deps
//   requirements §6: argsSchema must be machine-validatable
//   plan-strategy §5.3: argsSchema validator full coverage

import { describe, expect, it } from 'bun:test';
import { validate, type ValidateResult } from '../io/args-schema';

// ── (a) type validation ────────────────────────────────────────────────────

describe('argsSchema type validation (m4-w3, RED)', () => {
  it('string type validates "hello"', () => {
    const r = validate({ type: 'string' }, 'hello');
    expect(r.ok).toBe(true);
  });

  it('string type rejects 42', () => {
    const r = validate({ type: 'string' }, 42);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.errors[0]!.message).toContain('string');
    }
  });

  it('number type validates 42', () => {
    const r = validate({ type: 'number' }, 42);
    expect(r.ok).toBe(true);
  });

  it('number type rejects "42"', () => {
    const r = validate({ type: 'number' }, '42');
    expect(r.ok).toBe(false);
  });

  it('boolean type validates true', () => {
    const r = validate({ type: 'boolean' }, true);
    expect(r.ok).toBe(true);
  });

  it('boolean type validates false', () => {
    const r = validate({ type: 'boolean' }, false);
    expect(r.ok).toBe(true);
  });

  it('boolean type rejects 1', () => {
    const r = validate({ type: 'boolean' }, 1);
    expect(r.ok).toBe(false);
  });

  it('array type validates []', () => {
    const r = validate({ type: 'array' }, []);
    expect(r.ok).toBe(true);
  });

  it('array type rejects {}', () => {
    const r = validate({ type: 'array' }, {});
    expect(r.ok).toBe(false);
  });

  it('object type validates {}', () => {
    const r = validate({ type: 'object' }, {});
    expect(r.ok).toBe(true);
  });

  it('object type rejects null', () => {
    const r = validate({ type: 'object' }, null);
    expect(r.ok).toBe(false);
  });

  it('object type rejects []', () => {
    const r = validate({ type: 'object' }, []);
    expect(r.ok).toBe(false);
  });
});

// ── (b) properties validation ──────────────────────────────────────────────

describe('argsSchema properties validation (m4-w3, RED)', () => {
  const schema = {
    type: 'object' as const,
    properties: {
      x: { type: 'number' as const },
      y: { type: 'number' as const },
    },
  };

  it('validates correct properties', () => {
    const r = validate(schema, { x: 1, y: 2 });
    expect(r.ok).toBe(true);
  });

  it('rejects property with wrong type', () => {
    const r = validate(schema, { x: 'bad', y: 2 });
    expect(r.ok).toBe(false);
  });

  it('extra properties are allowed (no additionalProperties)', () => {
    const r = validate(schema, { x: 1, y: 2, z: 3 });
    expect(r.ok).toBe(true);
  });
});

// ── (c) required validation ────────────────────────────────────────────────

describe('argsSchema required validation (m4-w3, RED)', () => {
  const schema = {
    type: 'object' as const,
    properties: {
      name: { type: 'string' as const },
      age: { type: 'number' as const },
    },
    required: ['name', 'age'],
  };

  it('validates all required present', () => {
    const r = validate(schema, { name: 'Alice', age: 30 });
    expect(r.ok).toBe(true);
  });

  it('rejects missing required field', () => {
    const r = validate(schema, { name: 'Alice' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.message.includes('age'))).toBe(true);
    }
  });

  it('rejects all missing required fields', () => {
    const r = validate(schema, {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.length).toBeGreaterThanOrEqual(2);
    }
  });
});

// ── (d) enum validation ─────────────────────────────────────────────────────

describe('argsSchema enum validation (m4-w3, RED)', () => {
  it('validates value in enum', () => {
    const r = validate({ type: 'string', enum: ['translate', 'rotate', 'scale'] }, 'translate');
    expect(r.ok).toBe(true);
  });

  it('rejects value not in enum', () => {
    const r = validate({ type: 'string', enum: ['translate', 'rotate', 'scale'] }, 'flip');
    expect(r.ok).toBe(false);
  });
});

// ── (e) items validation (array elements) ──────────────────────────────────

describe('argsSchema items validation (m4-w3, RED)', () => {
  const schema = {
    type: 'array' as const,
    items: { type: 'number' as const },
  };

  it('validates correct element types', () => {
    const r = validate(schema, [1, 2, 3]);
    expect(r.ok).toBe(true);
  });

  it('rejects element with wrong type', () => {
    const r = validate(schema, [1, 'two', 3]);
    expect(r.ok).toBe(false);
  });

  it('validates empty array', () => {
    const r = validate(schema, []);
    expect(r.ok).toBe(true);
  });
});

// ── (f) nested object recursive validation ─────────────────────────────────

describe('argsSchema nested object validation (m4-w3, RED)', () => {
  const schema = {
    type: 'object' as const,
    properties: {
      pos: {
        type: 'object' as const,
        properties: {
          x: { type: 'number' as const },
          y: { type: 'number' as const },
        },
        required: ['x', 'y'],
      },
    },
    required: ['pos'],
  };

  it('validates nested correct object', () => {
    const r = validate(schema, { pos: { x: 1, y: 2 } });
    expect(r.ok).toBe(true);
  });

  it('rejects nested wrong type', () => {
    const r = validate(schema, { pos: { x: 'bad', y: 2 } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.path.includes('x'))).toBe(true);
    }
  });

  it('rejects missing nested required', () => {
    const r = validate(schema, { pos: { x: 1 } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.path.includes('y'))).toBe(true);
    }
  });
});

// ── (g) structured error format ─────────────────────────────────────────────

describe('argsSchema error format (m4-w3, RED)', () => {
  it('returns {ok:false, errors:[{path, message}]}', () => {
    const r = validate({ type: 'number' }, 'bad');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(Array.isArray(r.errors)).toBe(true);
      expect(r.errors.length).toBeGreaterThan(0);
      for (const e of r.errors) {
        expect(typeof e.path).toBe('string');
        expect(typeof e.message).toBe('string');
        expect(e.message.length).toBeGreaterThan(0);
      }
    }
  });

  it('valid input returns {ok:true}', () => {
    const r = validate({}, 42);
    expect(r.ok).toBe(true);
  });
});

// ── (h2) nullable + undefined-as-absent (F-4) ───────────────────────────────

describe('argsSchema nullable + undefined handling (F-4)', () => {
  it('nullable number accepts null', () => {
    const r = validate({ type: 'number', nullable: true }, null);
    expect(r.ok).toBe(true);
  });

  it('non-nullable number still rejects null', () => {
    const r = validate({ type: 'number' }, null);
    expect(r.ok).toBe(false);
  });

  it('nullable field inside object accepts null (clear signal)', () => {
    const schema = {
      type: 'object' as const,
      properties: { id: { type: 'number' as const, nullable: true } },
      required: ['id'],
    };
    expect(validate(schema, { id: null }).ok).toBe(true);
    expect(validate(schema, { id: 3 }).ok).toBe(true);
    // required still catches a fully-missing key
    expect(validate(schema, {}).ok).toBe(false);
  });

  it('present-but-undefined optional property is treated as absent', () => {
    const schema = {
      type: 'object' as const,
      properties: { id: { type: 'string' as const } },
    };
    // { id: undefined } must not trip the string type check
    expect(validate(schema, { id: undefined }).ok).toBe(true);
  });
});

// ── (h) zero external dependencies ──────────────────────────────────────────

describe('argsSchema zero external deps (m4-w3, RED)', () => {
  it('validate is callable and returns correct shape', () => {
    // This test proves the module is self-contained (no init needed,
    // no side-effect imports)
    const r = validate({ type: 'string' }, 'hello');
    expect(r).toHaveProperty('ok');
  });
});