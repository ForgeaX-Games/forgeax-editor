// io/args-schema.ts — lightweight JSON-Schema subset validator (M4)
//
// feat-20260706-editor-op-gateway-single-entry-b-catalog-defineop M4:
// Validates op args against an ArgsSchema (D-3 lightweight JSON-Schema subset).
// Fields: type / properties / required / enum / items. Plain JSON serializable.
// ~100 lines, pure TypeScript, no external dependencies (no zod/ajv).
//
// Anchors:
//   plan-strategy §2 D-3: custom JSON-Schema subset, no new dependencies
//   requirements §6: argsSchema must be machine-validatable (Schema as Contract)

import type { ArgsSchema } from './catalog';

// ── Validation result ───────────────────────────────────────────────────────

export interface ValidationError {
  path: string;
  message: string;
}

export type ValidateResult =
  | { ok: true }
  | { ok: false; errors: ValidationError[] };

// ── Validator ────────────────────────────────────────────────────────────────

export function validate(schema: ArgsSchema, value: unknown): ValidateResult {
  const errors: ValidationError[] = [];
  _validate(schema, value, '', errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}

function _validate(
  schema: ArgsSchema,
  value: unknown,
  path: string,
  errors: ValidationError[],
): void {
  // F-4: `null` is accepted for nullable fields (the documented "clear" signal of
  // several session/transient ops — setSelection/setHoverEntity id:null, etc.) —
  // short-circuit before the type check so a nullable number field accepts null.
  if (value === null && schema.nullable) return;

  if (schema.type !== undefined) {
    const actualType = Array.isArray(value) ? 'array' : typeof value;
    if (schema.type === 'object') {
      if (actualType !== 'object' || value === null) {
        errors.push({ path: path || '(root)', message: `expected object, got ${actualType}` });
        return;
      }
    } else if (actualType !== schema.type) {
      errors.push({ path: path || '(root)', message: `expected ${schema.type}, got ${actualType}` });
      return;
    }
  }

  // ── content-validation (2026-07-23 args-schema-pattern follow-up) ────────
  // string length / regex checks; runs BEFORE the array/object branches so a
  // failing string doesn't fall through to the container walkers.
  if (schema.type === 'string' && typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({
        path: path || '(root)',
        message: `string too short (min ${schema.minLength}, got ${value.length})`,
      });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({
        path: path || '(root)',
        message: `string too long (max ${schema.maxLength}, got ${value.length})`,
      });
    }
    if (schema.pattern !== undefined) {
      const re = _compilePattern(schema.pattern);
      if (!re) {
        // Rejecting an unsafe/invalid pattern is a CATALOG bug (author error),
        // not a caller bug. Surface loud so tests catch it, but keep the
        // dispatch failure structured so nothing crashes.
        errors.push({
          path: path || '(root)',
          message: `internal: catalog pattern is unsafe or invalid`,
        });
      } else if (!re.test(value)) {
        errors.push({
          path: path || '(root)',
          message: schema.patternHint ?? 'does not match required pattern',
        });
      }
    }
  }

  // number range checks
  if (schema.type === 'number' && typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({
        path: path || '(root)',
        message: `number below minimum (>= ${schema.minimum}, got ${value})`,
      });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({
        path: path || '(root)',
        message: `number above maximum (<= ${schema.maximum}, got ${value})`,
      });
    }
  }

  // type: 'array'
  if (schema.type === 'array' && Array.isArray(value)) {
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const itemPath = path ? `${path}[${i}]` : `[${i}]`;
        _validate(schema.items, value[i], itemPath, errors);
      }
    }
    return;
  }

  // type: 'object'
  if (schema.type === 'object' && typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;

    // required check
    if (schema.required) {
      for (const req of schema.required) {
        if (!(req in obj)) {
          const reqPath = path ? `${path}.${req}` : req;
          errors.push({ path: reqPath, message: `missing required field "${req}"` });
        }
      }
    }

    // properties
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        // F-4: an explicit `undefined` value is treated as absent — a caller that
        // spreads an optional field (setSceneId({ id: queryParam })) where the
        // value is undefined must not trip the property's type check. A missing
        // REQUIRED field is still caught by the required loop above.
        if (key in obj && obj[key] !== undefined) {
          const propPath = path ? `${path}.${key}` : key;
          _validate(propSchema, obj[key], propPath, errors);
        }
      }
    }

    // enum on the value (for discriminated union support)
    if (schema.enum !== undefined) {
      // enum applies to the value itself, not the object
      if (!schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
        errors.push({ path: path || '(root)', message: `value not in allowed enum` });
      }
    }
    return;
  }

  // non-object enum check
  if (schema.enum !== undefined) {
    if (!schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
      errors.push({ path: path || '(root)', message: `value not in allowed enum` });
    }
  }
}

// ── Safe pattern compilation (memoized, ReDoS-defensive) ──────────────────
//
// We accept a DELIBERATELY narrow regex subset to prevent catastrophic
// backtracking (ReDoS) from a mis-authored catalog schema. Rejects on sight
// (via `_UNSAFE_RE`):
//   - lookbehind / lookahead assertions:      (?<= (?<! (?=  (?!  (?P<name>
//   - backreferences:                         \1 .. \9
//   - "group + unbounded quantifier":         )+ )*  or  |…)+  |…)*
//
// Allowed:
//   - character classes with printable ranges + \x00-\xff hex escapes
//   - anchors ^ $
//   - +/*/? applied to characters or character classes
//   - {n,m} bounded quantifiers
//   - literal escapes \\ \. \+ \* \? \| \( \) \[ \] \{ \} \^ \$
//
// This is enough for basename / GUID / semver / bounded path patterns. If a
// future op needs richer regex it should probably move the check into its
// applier and use the schema pattern only as a coarse pre-filter.

const _patternCache = new Map<string, RegExp | null>();
const _UNSAFE_RE = /\(\?[<=!P]|\\[1-9]|\)[+*]|\|[^)]*\)[+*]/;

function _compilePattern(pat: string): RegExp | null {
  const cached = _patternCache.get(pat);
  if (cached !== undefined) return cached;
  if (_UNSAFE_RE.test(pat)) {
    _patternCache.set(pat, null);
    return null;
  }
  try {
    const re = new RegExp(pat);
    _patternCache.set(pat, re);
    return re;
  } catch {
    _patternCache.set(pat, null);
    return null;
  }
}