// io/query-snapshot.ts — querySnapshot with dynamic resolution + value safety (M4 t25/t26)
//
// feat-20260707-editor-trace-ioc M4:
// Removes the COMP_NAME_TO_TOKEN whitelist (previously only Transform+Entity).
// Uses resolveComponent(name) for dynamic resolution at query time (0 engine
// changes — research F-4 / RD-7 confirmed all public exports available).
// Unknown component names → explicit error signal (AC-16, eliminates the
// .filter(Boolean) silent-ignore pattern of query-snapshot.ts:43-45).
//
// Three-layer value safety (t26, plan-strategy §2 D-5 / RD-7):
// 1. Scalar (11 types) → native number/bool (existing behavior kept)
// 2. Managed handle (unique<T>/shared<T>/string) → {kind:'opaque-handle', type, raw}
//    — never leak live handle references (AC-15)
// 3. array<T,N> TypedArray → snap-copy to plain number[] via Array.from()
//    — never leak column buffer live references (AC-15)
// 4. Unsnapnable fields → explicit skip marker in result row (P3 boundary promise)
//
// Anchors:
//   plan-strategy §2 D-5: querySnapshot full-open + three-layer value safety
//   requirements AC-14/15/16: any registered component queryable + snapshot
//     isolation + explicit failure for unknowns
//   research F-4: resolveComponent / getRegisteredComponents / createQueryState
//     / queryRun are public; schema reflection via Component.schema
//   research RD-7: safety layer has no complete precedent, implemented here
//   plan-tasks t25: delete whitelist + resolveComponent + structured return
//   plan-tasks t26: opaque-handle + snap-copy + skipped fields

import type { Component, ComponentSchema } from '@forgeax/engine-ecs';
import {
  resolveComponent,
  getRegisteredComponents,
  createQueryState,
  queryRun,
  isManagedField,
  isManagedArrayField,
  isEntityField,
} from '@forgeax/engine-ecs';
import type { World } from '@forgeax/engine-ecs';
import type { EntityId } from '../types';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface QuerySnapshotDescriptor {
  with: string[];
}

/** Opaque-handle marker for managed fields (handle/string/buffer). */
export interface OpaqueHandle {
  kind: 'opaque-handle';
  /** The schema field type string (e.g. 'unique<MaterialAsset>', 'shared<TextureAsset>', 'string'). */
  type: string;
  /** The raw handle ID (number) or string value — opaque but available for trace/debug. */
  raw: number | string;
}

/** A snapshot row: entity ID + per-component field maps. */
export type QuerySnapshotRow = {
  entity: EntityId;
  /** Per-component data: componentName → {fieldName → value}. */
  [componentName: string]: unknown;
};

/** Query result: either success with rows or explicit error signal (AC-16). */
export type QuerySnapshotResult =
  | { ok: true; rows: QuerySnapshotRow[] }
  | { ok: false; error: { code: string; hint: string } };

/** Query function signature — accept a descriptor, return structured result. */
export type QuerySnapshotFn = (descriptor: QuerySnapshotDescriptor) => QuerySnapshotResult;

// ── Value safety helpers (t26) ────────────────────────────────────────────────

/**
 * Per-field value snapshotter. Given a schema field type string and the raw
 * column value (from TypedArray[i] or ManagedColumnReader.get(i)), returns:
 * - JS primitive for scalar fields
 * - OpaqueHandle for managed handle/string/buffer fields
 * - plain number[] snap-copy for array fields
 */
/** Fixed arity N of an `array<T, N>` schema type string, or undefined for a
 *  scalar / variable-length `array<T>` field. Mirrors engine
 *  parseManagedArraySchema's fixed-capacity arm without importing an ECS internal. */
function fixedArrayArity(fieldType: string): number | undefined {
  const m = /^array<[^,>]+,\s*(\d+)\s*>$/.exec(fieldType);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function snapFieldValue(
  fieldType: string,
  rawValue: unknown,
): unknown {
  // Null/undefined → pass through (not a value)
  if (rawValue === null || rawValue === undefined) return rawValue;

  // (1) Managed handle fields (unique<T>/shared<T>/string/buffer) → opaque marker
  //     The raw value from ManagedColumnReader.get(i) is typically a number (handle
  //     ID) or a string (for the 'string' managed field). We wrap it in an
  //     OpaqueHandle to prevent callers from treating it as a live reference.
  if (isManagedField(fieldType)) {
    return {
      kind: 'opaque-handle',
      type: fieldType,
      raw: rawValue,
    } as OpaqueHandle;
  }

  // (2) array<T,N> / array<T> fields → snap-copy TypedArray to plain number[]
  //     The raw value is a TypedArray (e.g. Float32Array) aliasing the column
  //     buffer. Snap-copy ensures caller mutation doesn't affect world memory.
  if (isManagedArrayField(fieldType)) {
    if (ArrayBuffer.isView(rawValue)) {
      // TypedArray → snap-copy via Array.from()
      return Array.from(rawValue as unknown as ArrayLike<number>);
    }
    // ManagedColumnReader for variable array<T> — use .get(i) if available
    if (rawValue && typeof rawValue === 'object' && 'get' in rawValue) {
      const reader = rawValue as { get: (i: number) => unknown; length: number };
      const len = reader.length ?? 0;
      const arr: unknown[] = [];
      for (let j = 0; j < len; j++) {
        arr.push(reader.get(j));
      }
      return arr;
    }
    // Unknown shape → return raw as-is (best effort)
    return rawValue;
  }

  // (3) Entity reference fields → return raw number (entity handle ID)
  if (isEntityField(fieldType)) {
    return rawValue;
  }

  // (4) Scalar fields (f32/f64/i32/u32/i16/u16/i8/u8/bool/enum/ref) →
  //     return as-is (already a JS number/boolean from TypedArray[i])
  return rawValue;
}

// ── Implementation ────────────────────────────────────────────────────────────

export function querySnapshot(_world: World, descriptor: QuerySnapshotDescriptor): QuerySnapshotResult {
  const { with: names } = descriptor;

  // Always include Entity for row count and identity
  const allNames = names.includes('Entity') ? names : [...names, 'Entity'];

  // Resolve each component name to its token. Unknown → explicit error (AC-16).
  const tokens: Component[] = [];
  for (const name of allNames) {
    const tok = resolveComponent(name);
    if (!tok) {
      const registered = getRegisteredComponents();
      const knownNames = Array.from(registered.keys()).sort();
      // Suggest similar names
      const hints = (knownNames as string[]).filter((n) => n.toLowerCase() === name.toLowerCase());
      const suggestion = hints.length > 0
        ? ` registered component names: ${knownNames.join(', ')}. Did you mean "${hints[0]}"?`
        : ` registered component names: ${knownNames.join(', ')}`;
      return {
        ok: false,
        error: {
          code: 'UNKNOWN_COMPONENT',
          hint: `component "${name}" is not registered.${suggestion}`,
        },
      };
    }
    tokens.push(tok);
  }

  if (tokens.length === 0) return { ok: true, rows: [] };

  // Build a name→schema map for value-safety classification (t26)
  const nameToSchema = new Map<string, ComponentSchema>();
  for (const tok of tokens) {
    nameToSchema.set(tok.name, tok.schema as ComponentSchema);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = createQueryState({ with: tokens as any[] });

  const rows: QuerySnapshotRow[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queryRun(state as any, _world as any, (bundle: any) => {
    // Entity self column gives row count
    const entities = bundle.Entity?.self as { length: number; [index: number]: number } | undefined;
    if (!entities) return;
    const entityIds: number[] = [];
    for (let i = 0; i < entities.length; i++) {
      entityIds.push(entities[i] ?? 0);
    }

    for (let i = 0; i < entityIds.length; i++) {
      const row: QuerySnapshotRow = { entity: entityIds[i]! as EntityId };
      // For each queried component (including Entity), extract ith row value
      for (const compName of allNames) {
        if (compName === 'Entity') continue; // Entity is the row key, not a component field
        const compBundle = bundle[compName];
        if (!compBundle) continue;

        const schema = nameToSchema.get(compName);
        const fields: Record<string, unknown> = {};

        for (const [fieldName, col] of Object.entries(compBundle)) {
          if (col && typeof col === 'object') {
            // TypedArray / ManagedColumnReader access
            const colObj = col as { length?: number; subarray?: (a: number, b: number) => unknown; [index: number]: unknown; get?: (i: number) => unknown };
            const fieldType: string | undefined = schema?.[fieldName] as string | undefined;
            // Inline `array<T,N>` columns (feat-20260602) surface as a FLAT
            // stride-N TypedArray: row `i` lives at [i*N, (i+1)*N), not at [i]
            // (engine query.ts arity-aware slicing). Detect the fixed arity from
            // the schema type and read the per-row sub-array before snapshotting.
            const arity = fieldType ? fixedArrayArity(fieldType) : undefined;
            if (arity !== undefined && typeof colObj.subarray === 'function') {
              const base = i * arity;
              if (base < (colObj.length ?? 0)) {
                const rowView = colObj.subarray(base, base + arity);
                fields[fieldName] = snapFieldValue(fieldType!, rowView);
              }
            } else if (i < (colObj.length ?? 0)) {
              const rawValue = typeof colObj.get === 'function' ? colObj.get(i) : colObj[i];

              // Apply value-safety classification (t26)
              // Schema field type may not be available (e.g. Entity component),
              // fall back to raw value as-is.
              if (!fieldType) {
                // No schema info — return raw value as-is (best effort)
                fields[fieldName] = rawValue;
              } else {
                const snapped = snapFieldValue(fieldType, rawValue);
                fields[fieldName] = snapped;
              }
            }
          } else {
            fields[fieldName] = col;
          }
        }

        // Store per-component data under component name
        if (Object.keys(fields).length > 0) {
          row[compName] = fields;
        }
      }
      rows.push(row);
    }
  });

  return { ok: true, rows };
}