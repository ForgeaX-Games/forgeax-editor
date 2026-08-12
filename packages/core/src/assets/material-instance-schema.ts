// material-instance-schema — editor-owned Material Instance asset shape.
//
// Engine Asset union has only `kind:'material'` (parent + values merge). The MI
// product model (UE-style override toggles, Phys Material, Lightmass) lives here
// as an editor kind. Runtime rendering always consumes a resolved MaterialAsset
// values map (see material-instance-resolve.ts) — never a raw MI payload.
//
// Anchors: .forgeax-harness/docs/2026-08-05-material-instance-editor-tech-plan.md §A1

export const MATERIAL_INSTANCE_KIND = 'material-instance' as const;

/** Surface params exposed in the MI editor (static whitelist / FR-3.4). */
export const SURFACE_PARAM_KEYS = ['baseColor', 'metallic', 'roughness'] as const;
export type SurfaceParamKey = (typeof SURFACE_PARAM_KEYS)[number];

export interface MaterialInstanceOverride {
  readonly enabled: boolean;
  readonly value?: unknown;
}

export interface MaterialInstanceLightmass {
  readonly castShadowsAsMasked: boolean;
  readonly emissiveBoost: number;
  readonly diffuseBoost: number;
  readonly exportResolutionScale: number;
}

export interface MaterialInstancePayload {
  readonly kind: typeof MATERIAL_INSTANCE_KIND;
  /** Parent Material or Material Instance GUID. */
  readonly parent: string;
  /** Optional Physical Material GUID (editor-stored; engine does not consume yet). */
  readonly physMaterial?: string;
  /** Per-parameter override map (enabled gate + value). */
  readonly overrides: Readonly<Record<string, MaterialInstanceOverride>>;
  readonly lightmass: MaterialInstanceLightmass;
  /** Placeholder for dynamic property overrides (same shape as overrides). */
  readonly propertyOverrides?: Readonly<Record<string, MaterialInstanceOverride>>;
}

export const DEFAULT_LIGHTMASS: MaterialInstanceLightmass = {
  castShadowsAsMasked: false,
  emissiveBoost: 1,
  diffuseBoost: 1,
  exportResolutionScale: 1,
};

const GUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isGuid(value: unknown): value is string {
  return typeof value === 'string' && GUID_LIKE.test(value);
}

export function isMaterialInstancePayload(value: unknown): value is MaterialInstancePayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return payload.kind === MATERIAL_INSTANCE_KIND && isGuid(payload.parent);
}

export function createDefaultMaterialInstancePayload(
  parentGuid: string,
  options?: {
    readonly physMaterial?: string;
    readonly overrides?: Readonly<Record<string, MaterialInstanceOverride>>;
    readonly lightmass?: Partial<MaterialInstanceLightmass>;
  },
): MaterialInstancePayload {
  if (!isGuid(parentGuid)) {
    throw new Error('createDefaultMaterialInstancePayload requires a valid parent GUID');
  }
  return {
    kind: MATERIAL_INSTANCE_KIND,
    parent: parentGuid,
    ...(options?.physMaterial !== undefined ? { physMaterial: options.physMaterial } : {}),
    overrides: { ...(options?.overrides ?? {}) },
    lightmass: { ...DEFAULT_LIGHTMASS, ...(options?.lightmass ?? {}) },
    propertyOverrides: {},
  };
}

export interface EncodeMaterialInstancePackRefsResult {
  readonly ok: true;
  readonly payload: MaterialInstancePayload;
  readonly refs: string[];
  readonly changed: boolean;
}

export interface EncodeMaterialInstancePackRefsError {
  readonly ok: false;
  readonly error: { readonly code: 'MI_PACK_REFS_INVALID'; readonly field: string; readonly hint: string };
}

/**
 * Encode an MI payload into pack wire form: parent + physMaterial GUIDs appear
 * in refs[] (and remain as GUID strings on the payload for editor reads).
 */
export function encodeMaterialInstancePackRefs(
  payload: unknown,
  refs?: readonly unknown[],
): EncodeMaterialInstancePackRefsResult | EncodeMaterialInstancePackRefsError {
  if (!isMaterialInstancePayload(payload)) {
    return {
      ok: false,
      error: {
        code: 'MI_PACK_REFS_INVALID',
        field: 'payload',
        hint: 'Material instance payload must be an object with kind "material-instance" and a parent GUID.',
      },
    };
  }

  const normalizedRefs: string[] = [];
  for (const [index, value] of (refs ?? []).entries()) {
    const guid =
      typeof value === 'string'
        ? value
        : typeof value === 'object' && value !== null && typeof (value as { guid?: unknown }).guid === 'string'
          ? (value as { guid: string }).guid
          : undefined;
    if (guid === undefined || guid.length === 0) {
      return {
        ok: false,
        error: {
          code: 'MI_PACK_REFS_INVALID',
          field: `refs[${index}]`,
          hint: 'Material instance refs contain an entry without a string asset GUID.',
        },
      };
    }
    if (!normalizedRefs.includes(guid)) normalizedRefs.push(guid);
  }

  const ensureRef = (guid: string): void => {
    if (!normalizedRefs.includes(guid)) normalizedRefs.push(guid);
  };

  if (!isGuid(payload.parent)) {
    return {
      ok: false,
      error: {
        code: 'MI_PACK_REFS_INVALID',
        field: 'parent',
        hint: 'Material instance parent must be a valid asset GUID.',
      },
    };
  }
  ensureRef(payload.parent);

  if (payload.physMaterial !== undefined) {
    if (!isGuid(payload.physMaterial)) {
      return {
        ok: false,
        error: {
          code: 'MI_PACK_REFS_INVALID',
          field: 'physMaterial',
          hint: 'Material instance physMaterial must be a valid asset GUID when present.',
        },
      };
    }
    ensureRef(payload.physMaterial);
  }

  const previous = Array.isArray(refs)
    ? refs.map((value) =>
        typeof value === 'string'
          ? value
          : typeof value === 'object' && value !== null && typeof (value as { guid?: unknown }).guid === 'string'
            ? (value as { guid: string }).guid
            : '',
      )
    : [];
  const changed =
    previous.length !== normalizedRefs.length ||
    previous.some((guid, index) => guid !== normalizedRefs[index]);

  return {
    ok: true,
    payload: {
      kind: MATERIAL_INSTANCE_KIND,
      parent: payload.parent,
      ...(payload.physMaterial !== undefined ? { physMaterial: payload.physMaterial } : {}),
      overrides: { ...payload.overrides },
      lightmass: { ...payload.lightmass },
      propertyOverrides: { ...(payload.propertyOverrides ?? {}) },
    },
    refs: normalizedRefs,
    changed,
  };
}

/** Normalize every material-instance entry in a Pack object (mutates only after all pass). */
export function normalizeMaterialInstancePackEntries(
  pack: Record<string, unknown>,
):
  | { readonly ok: true; readonly changed: boolean; readonly changedEntries: readonly Record<string, unknown>[] }
  | { readonly ok: false; readonly error: EncodeMaterialInstancePackRefsError['error'] & { readonly field: string } } {
  const assets = pack.assets;
  if (!Array.isArray(assets)) return { ok: true, changed: false, changedEntries: [] };

  const updates: Array<{
    readonly entry: Record<string, unknown>;
    readonly payload: MaterialInstancePayload;
    readonly refs: string[];
  }> = [];

  for (const [index, asset] of assets.entries()) {
    if (typeof asset !== 'object' || asset === null || Array.isArray(asset)) continue;
    const entry = asset as Record<string, unknown>;
    if (entry.kind !== MATERIAL_INSTANCE_KIND) continue;
    const encoded = encodeMaterialInstancePackRefs(entry.payload, entry.refs as readonly unknown[] | undefined);
    if (!encoded.ok) {
      return {
        ok: false,
        error: {
          ...encoded.error,
          field: `assets[${index}].${encoded.error.field}`,
        },
      };
    }
    if (encoded.changed) {
      updates.push({ entry, payload: encoded.payload, refs: encoded.refs });
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
