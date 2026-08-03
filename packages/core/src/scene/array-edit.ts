// R0-03D — schema-driven array edit planning.
//
// This is a pure read-side planner. It never writes the World; callers turn its
// one complete patch into the existing document-domain setComponent op. Keeping
// add/remove/reorder/update here gives the AI and Inspector the same group,
// index, and default semantics without creating a second mutation door.

import { getComponentSchema, type FieldSchema } from './schema';

export type ArrayEditAction = 'add' | 'remove' | 'reorder' | 'update';

export interface ArrayEditRequest {
  readonly component: string;
  readonly field: string;
  readonly action: ArrayEditAction;
  readonly index?: number;
  readonly toIndex?: number;
  readonly value?: unknown;
}

export type ArrayEditPlan =
  | { readonly ok: true; readonly patch: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly fieldPath: string;
      readonly reason: string;
      readonly hint: string;
    };

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function toItems(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return [...value];
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<unknown>);
  return null;
}

function fail(request: ArrayEditRequest, reason: string, hint: string, suffix = ''): ArrayEditPlan {
  return {
    ok: false,
    fieldPath: `${request.component}.${request.field}${suffix}`,
    reason,
    hint,
  };
}

export interface GroupedArrayPatchRequest {
  readonly component: string;
  readonly field: string;
  /** Replace the complete target array when `slot` is omitted. */
  readonly value: unknown;
  /** Replace one slot and preserve the other slots when present. */
  readonly slot?: number;
}

export type GroupedArrayPatchPlan =
  | { readonly ok: true; readonly patch: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly fieldPath: string;
      readonly reason: string;
      readonly hint: string;
    };

function defaultElement(field: FieldSchema): unknown {
  if (field.arrayElementDefault !== undefined) return cloneValue(field.arrayElementDefault);
  const elementType = field.arrayMeta?.elementType ?? '';
  if (elementType === 'bool') return false;
  if (elementType === 'string') return '';
  return 0;
}

/**
 * Plan a shared-array write while keeping every producer-declared parallel
 * column aligned. This is the generic counterpart to `planArrayEdit`: callers
 * such as asset binders may replace a whole array or target a slot, but still
 * submit exactly one complete group patch through setComponent.
 */
export function planGroupedArrayPatch(
  request: GroupedArrayPatchRequest,
  data: Record<string, unknown>,
): GroupedArrayPatchPlan {
  const schema = getComponentSchema(request.component);
  const field = schema?.fields.find((candidate) => candidate.key === request.field);
  if (field?.arrayMeta === undefined) {
    return {
      ok: false,
      fieldPath: `${request.component}.${request.field}`,
      reason: 'array-field-required',
      hint: `${request.component}.${request.field} is not an editable array field`,
    };
  }

  if (request.slot !== undefined && (!Number.isInteger(request.slot) || request.slot < 0)) {
    return {
      ok: false,
      fieldPath: `${request.component}.${request.field}[${request.slot}]`,
      reason: 'index-out-of-range',
      hint: `${request.component}.${request.field}[${request.slot}] requires a non-negative integer slot`,
    };
  }

  const group = field.arrayGroup;
  const fields = (schema?.fields ?? []).filter((candidate) =>
    candidate.arrayMeta !== undefined && (group === undefined ? candidate.key === field.key : candidate.arrayGroup === group));
  const arrays = new Map<string, unknown[]>();
  for (const candidate of fields) {
    const items = toItems(data[candidate.key]);
    if (items === null) {
      return {
        ok: false,
        fieldPath: `${request.component}.${candidate.key}`,
        reason: 'array-required',
        hint: `${request.component}.${candidate.key} must be present as an array`,
      };
    }
    arrays.set(candidate.key, items);
  }

  const lengths = [...arrays.entries()].map(([key, items]) => [key, items.length] as const);
  const currentLength = lengths[0]?.[1] ?? 0;
  const mismatch = lengths.find(([, length]) => length !== currentLength);
  if (mismatch !== undefined) {
    return {
      ok: false,
      fieldPath: `${request.component}.${mismatch[0]}`,
      reason: 'parallel-array-length',
      hint: `${request.component}.${mismatch[0]} has ${mismatch[1]} items; expected ${currentLength}`,
    };
  }

  let target: unknown[];
  let targetLength: number;
  if (request.slot !== undefined) {
    target = [...(arrays.get(field.key) ?? [])];
    targetLength = Math.max(currentLength, request.slot + 1);
    while (target.length < targetLength) target.push(defaultElement(field));
    target[request.slot] = cloneValue(request.value);
  } else {
    const replacement = toItems(request.value);
    if (replacement === null) {
      return {
        ok: false,
        fieldPath: `${request.component}.${request.field}`,
        reason: 'array-required',
        hint: `${request.component}.${request.field} requires an array value`,
      };
    }
    target = replacement;
    targetLength = replacement.length;
  }

  if (field.arrayMeta.length !== undefined && targetLength !== field.arrayMeta.length) {
    return {
      ok: false,
      fieldPath: `${request.component}.${request.field}`,
      reason: 'fixed-array-length',
      hint: `${request.component}.${request.field} requires exactly ${field.arrayMeta.length} items (received ${targetLength})`,
    };
  }

  const patch = new Map<string, unknown[]>();
  for (const candidate of fields) {
    if (candidate.key === field.key) {
      patch.set(candidate.key, target);
      continue;
    }
    const items = [...(arrays.get(candidate.key) ?? [])].slice(0, targetLength);
    while (items.length < targetLength) items.push(defaultElement(candidate));
    patch.set(candidate.key, items);
  }
  return { ok: true, patch: Object.fromEntries(patch) };
}

function move<T>(items: T[], from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

/** Plan one container gesture as one complete top-level component patch. */
export function planArrayEdit(
  request: ArrayEditRequest,
  data: Record<string, unknown>,
): ArrayEditPlan {
  const field = getComponentSchema(request.component)?.fields.find((candidate) => candidate.key === request.field);
  if (field?.arrayMeta === undefined) {
    return fail(request, 'array-field-required', `${request.component}.${request.field} is not an editable array field`);
  }

  const group = field.arrayGroup;
  const fields = (getComponentSchema(request.component)?.fields ?? [])
    .filter((candidate) => candidate.arrayMeta !== undefined && (group === undefined ? candidate.key === field.key : candidate.arrayGroup === group));
  const arrays = new Map<string, unknown[]>();
  for (const candidate of fields) {
    const items = toItems(data[candidate.key]);
    if (items === null) {
      return fail(request, 'array-required', `${request.component}.${candidate.key} must be present as an array`);
    }
    arrays.set(candidate.key, items);
  }

  const lengths = [...arrays.entries()].map(([key, items]) => [key, items.length] as const);
  const expectedLength = lengths[0]?.[1] ?? 0;
  const mismatch = lengths.find(([, length]) => length !== expectedLength);
  if (mismatch !== undefined) {
    return fail(request, 'parallel-array-length', `${request.component}.${mismatch[0]} has ${mismatch[1]} items; expected ${expectedLength}`);
  }

  const index = request.index;
  const toIndex = request.toIndex;
  if (request.action === 'add') {
    if (field.arrayMeta.length !== undefined) {
      return fail(request, 'fixed-array', `${request.component}.${request.field} has fixed capacity ${field.arrayMeta.length}`);
    }
    const insertion = index ?? expectedLength;
    if (!Number.isInteger(insertion) || insertion < 0 || insertion > expectedLength) {
      return fail(request, 'index-out-of-range', `${request.component}.${request.field}[${insertion}] is outside insertion range 0..${expectedLength}`, `[${insertion}]`);
    }
    for (const candidate of fields) {
      const items = arrays.get(candidate.key)!;
      items.splice(insertion, 0, candidate.key === field.key ? cloneValue(request.value ?? defaultElement(field)) : defaultElement(candidate));
    }
  } else {
    const candidateIndex = typeof index === 'number' ? index : -1;
    if (!Number.isInteger(candidateIndex) || candidateIndex < 0 || candidateIndex >= expectedLength) {
      return fail(request, 'index-out-of-range', `${request.component}.${request.field}[${candidateIndex}] is outside range 0..${Math.max(0, expectedLength - 1)}`, `[${candidateIndex}]`);
    }
    const currentIndex = candidateIndex;
    if (request.action === 'remove') {
      if (field.arrayMeta.length !== undefined) {
        return fail(request, 'fixed-array', `${request.component}.${request.field} cannot remove from fixed capacity ${field.arrayMeta.length}`, `[${index}]`);
      }
      for (const items of arrays.values()) items.splice(currentIndex, 1);
    } else if (request.action === 'reorder') {
      const candidateDestination = typeof toIndex === 'number' ? toIndex : -1;
      if (!Number.isInteger(candidateDestination) || candidateDestination < 0 || candidateDestination >= expectedLength) {
        return fail(request, 'index-out-of-range', `${request.component}.${request.field}[${candidateDestination}] is outside range 0..${Math.max(0, expectedLength - 1)}`, `[${candidateDestination}]`);
      }
      const destinationIndex = candidateDestination;
      for (const [key, items] of arrays) arrays.set(key, move(items, currentIndex, destinationIndex));
    } else {
      if (!('value' in request)) {
        return fail(request, 'value-required', `${request.component}.${request.field}[${currentIndex}] update requires a value`, `[${currentIndex}]`);
      }
      for (const [key, items] of arrays) {
        if (key === field.key) items[currentIndex] = cloneValue(request.value);
      }
    }
  }

  return { ok: true, patch: Object.fromEntries([...arrays].map(([key, items]) => [key, items])) };
}
