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