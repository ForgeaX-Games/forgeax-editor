// io/material-pack-refs — the editor-owned material wire-format boundary.
//
// Engine memory uses texture GUIDs (or MaterialTextureValue objects), while
// Pack v2 stores material asset references in refs[] and writes numeric indices
// into values. Keeping this conversion here prevents create, update, save, and
// load migration paths from inventing slightly different encodings.

export interface MaterialPackRefError {
  readonly code: 'MATERIAL_PACK_MIGRATION_UNSAFE';
  readonly field: string;
  readonly hint: string;
}

export type EncodeMaterialPackRefsResult =
  | {
      readonly ok: true;
      readonly payload: Record<string, unknown>;
      readonly refs: string[];
      /** True when the payload or refs changed from the supplied wire/runtime form. */
      readonly changed: boolean;
    }
  | { readonly ok: false; readonly error: MaterialPackRefError };

export type NormalizeMaterialPackEntriesResult =
  | {
      readonly ok: true;
      readonly changed: boolean;
      readonly changedEntries: readonly Record<string, unknown>[];
    }
  | { readonly ok: false; readonly error: MaterialPackRefError };

const FALLBACK_TEXTURE_FIELDS = [
  'baseColorTexture',
  'metallicRoughnessTexture',
  'normalTexture',
  'specularTintTexture',
  'emissiveTexture',
  'occlusionTexture',
] as const;

// These defaults match the authored standard-material POD. They are used only
// when an old pack put an asset GUID into a numeric field (the known bot.png
// shape: metallic was accidentally written with the baseColorTexture GUID).
const FALLBACK_NUMERIC_DEFAULTS: Readonly<Record<string, number>> = {
  metallic: 0,
  roughness: 0.5,
  metallicChannel: 0,
  roughnessChannel: 0,
  aoChannel: 0,
  extraChannel: 0,
  emissiveIntensity: 1,
  occlusionStrength: 1,
  alphaCutoff: 0,
  clearcoat: 0,
  clearcoatRoughness: 0,
};

const NUMERIC_PARAMETER_TYPES = new Set(['f32', 'i32', 'u32']);
const GUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isRecord(value)) {
    const copy: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) copy[key] = cloneValue(nested);
    return copy;
  }
  return value;
}

function refGuid(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (isRecord(value) && typeof value.guid === 'string' && value.guid.length > 0) {
    return value.guid;
  }
  return undefined;
}

function sameRefs(left: readonly unknown[] | undefined, right: readonly string[]): boolean {
  if (!Array.isArray(left) || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function parameterMap(payload: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(payload.parameters)) return result;
  for (const parameter of payload.parameters) {
    if (!isRecord(parameter) || typeof parameter.name !== 'string') continue;
    result.set(parameter.name, parameter);
  }
  return result;
}

function textureFieldNames(payload: Record<string, unknown>): Set<string> {
  const result = new Set<string>(FALLBACK_TEXTURE_FIELDS);
  if (Array.isArray(payload.parameters)) {
    for (const parameter of payload.parameters) {
      if (
        isRecord(parameter) &&
        parameter.type === 'texture' &&
        typeof parameter.name === 'string'
      ) {
        result.add(parameter.name);
      }
    }
  }
  return result;
}

function numericField(
  field: string,
  parameter: Record<string, unknown> | undefined,
): boolean {
  if (parameter !== undefined) {
    return typeof parameter.type === 'string' && NUMERIC_PARAMETER_TYPES.has(parameter.type);
  }
  return Object.prototype.hasOwnProperty.call(FALLBACK_NUMERIC_DEFAULTS, field);
}

function defaultNumericValue(
  field: string,
  parameter: Record<string, unknown> | undefined,
): unknown {
  if (parameter?.default !== undefined) return cloneValue(parameter.default);
  return FALLBACK_NUMERIC_DEFAULTS[field];
}

function fail(field: string, hint: string): EncodeMaterialPackRefsResult {
  return {
    ok: false,
    error: {
      code: 'MATERIAL_PACK_MIGRATION_UNSAFE',
      field,
      hint,
    },
  };
}

/**
 * Encode one material payload into Pack v2's refs + numeric-index form.
 *
 * `refs` accepts both the wire string[] form and the engine catalog's
 * `{ guid }[]` envelope form. The returned refs are always wire strings.
 */
export function encodeMaterialPackRefs(
  payload: unknown,
  refs?: readonly unknown[],
): EncodeMaterialPackRefsResult {
  if (!isRecord(payload) || payload.kind !== 'material') {
    return fail('payload', 'Material payload must be an object with kind "material".');
  }
  if (refs !== undefined && !Array.isArray(refs)) {
    return fail('refs', 'Material refs must be an array of asset GUIDs.');
  }

  const normalizedRefs: string[] = [];
  for (const [index, value] of (refs ?? []).entries()) {
    const guid = refGuid(value);
    if (guid === undefined) {
      return fail(`refs[${index}]`, 'Material refs contain an entry without a string asset GUID.');
    }
    normalizedRefs.push(guid);
  }

  const sourceValues = payload.values;
  if (sourceValues !== undefined && !isRecord(sourceValues)) {
    return fail('values', 'Material values must be an object when present.');
  }
  if (sourceValues === undefined) {
    return {
      ok: true,
      payload: { ...payload },
      refs: normalizedRefs,
      changed: !sameRefs(refs, normalizedRefs),
    };
  }

  const values: Record<string, unknown> = { ...sourceValues };
  const textureFields = textureFieldNames(payload);
  const parameters = parameterMap(payload);
  const textureGuids = new Set<string>();
  let changed = !sameRefs(refs, normalizedRefs);

  const ensureRef = (guid: string): number => {
    const existing = normalizedRefs.indexOf(guid);
    if (existing >= 0) return existing;
    normalizedRefs.push(guid);
    return normalizedRefs.length - 1;
  };

  const refIndex = (value: unknown): number | undefined => {
    if (typeof value === 'string') {
      if (value.length === 0) return undefined;
      textureGuids.add(value);
      return ensureRef(value);
    }
    if (typeof value === 'number' && Number.isInteger(value)) {
      const guid = normalizedRefs[value];
      if (guid === undefined) return undefined;
      textureGuids.add(guid);
      return value;
    }
    return undefined;
  };

  for (const field of textureFields) {
    if (!Object.prototype.hasOwnProperty.call(values, field)) continue;
    const value = values[field];
    if (value === null || value === undefined) continue;

    if (typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value))) {
      const index = refIndex(value);
      if (index === undefined) {
        return fail(
          `values.${field}`,
          `Texture field "${field}" does not resolve to a valid refs[] entry.`,
        );
      }
      if (value !== index) {
        values[field] = index;
        changed = true;
      }
      continue;
    }

    if (isRecord(value)) {
      const textureIndex = refIndex(value.texture);
      if (textureIndex === undefined) {
        return fail(
          `values.${field}.texture`,
          `Structured texture field "${field}" must contain a texture GUID or refs[] index.`,
        );
      }
      const nextValue: Record<string, unknown> = { ...value, texture: textureIndex };
      if (value.sampler !== undefined) {
        const samplerIndex = refIndex(value.sampler);
        if (samplerIndex === undefined) {
          return fail(
            `values.${field}.sampler`,
            `Structured texture field "${field}" has an invalid sampler reference.`,
          );
        }
        nextValue.sampler = samplerIndex;
      }
      values[field] = nextValue;
      changed =
        changed ||
        value.texture !== textureIndex ||
        (value.sampler !== undefined && value.sampler !== nextValue.sampler);
      continue;
    }

    return fail(`values.${field}`, `Texture field "${field}" has an unsupported value.`);
  }

  // Compatibility repair for packs written by the old material authoring path.
  // Only repair a numeric field when the same GUID is demonstrably used by a
  // texture slot. Any other invalid numeric value is rejected rather than
  // guessed, so an unsafe migration cannot silently change authored content.
  for (const [field, value] of Object.entries(values)) {
    if (textureFields.has(field) || typeof value !== 'string') continue;
    if (!numericField(field, parameters.get(field))) continue;
    if (!GUID_LIKE.test(value)) {
      return fail(
        `values.${field}`,
        `Numeric material field "${field}" contains a non-numeric string and cannot be migrated safely.`,
      );
    }
    if (!textureGuids.has(value)) {
      return fail(
        `values.${field}`,
        `Numeric material field "${field}" contains an asset GUID that is not paired with a texture slot.`,
      );
    }
    const replacement = defaultNumericValue(field, parameters.get(field));
    if (replacement === undefined) {
      return fail(
        `values.${field}`,
        `Numeric material field "${field}" has no safe default for migration.`,
      );
    }
    values[field] = replacement;
    changed = true;
  }

  return {
    ok: true,
    payload: { ...payload, values },
    refs: normalizedRefs,
    changed,
  };
}

/**
 * Normalize every material entry in a Pack object. The input is only mutated
 * after all material entries pass, so an unsafe migration never leaves a
 * partially migrated in-memory pack.
 */
export function normalizeMaterialPackEntries(
  pack: Record<string, unknown>,
): NormalizeMaterialPackEntriesResult {
  const assets = pack.assets;
  if (!Array.isArray(assets)) {
    return { ok: true, changed: false, changedEntries: [] };
  }

  const updates: Array<{
    readonly entry: Record<string, unknown>;
    readonly payload: Record<string, unknown>;
    readonly refs: string[];
  }> = [];

  for (const [index, asset] of assets.entries()) {
    if (!isRecord(asset) || asset.kind !== 'material') continue;
    const encoded = encodeMaterialPackRefs(asset.payload, asset.refs as readonly unknown[] | undefined);
    if (!encoded.ok) {
      return {
        ok: false,
        error: {
          ...encoded.error,
          field: `assets[${index}].${encoded.error.field}`,
        },
      };
    }
    if (encoded.changed || !sameRefs(asset.refs as readonly unknown[] | undefined, encoded.refs)) {
      updates.push({ entry: asset, payload: encoded.payload, refs: encoded.refs });
    }
  }

  for (const update of updates) {
    update.entry.payload = update.payload;
    update.entry.refs = update.refs;
  }
  return {
    ok: true,
    changed: updates.length > 0,
    changedEntries: updates.map(({ entry }) => entry),
  };
}
