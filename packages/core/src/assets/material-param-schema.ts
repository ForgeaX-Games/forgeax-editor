// assets/material-param-schema — schema-driven parameter model for the
// Material properties panel (the "not comprehensive" fix).
//
// WHY THIS EXISTS
//   The old material panel hard-coded baseColor / metallic / roughness + three
//   texture slots. The engine's SSOT for "which parameters a material shader
//   exposes" is the shader's paramSchema, shipped to every host inside the
//   shader manifest (`/shaders/manifest.json` → materialShaders[].paramSchema,
//   a JSON string) — the same manifest the renderer and the preview viewport
//   already boot from. This module turns (material payload × manifest) into a
//   flat row model the panel renders, so custom shaders and the full standard
//   PBR surface (emissive / clearcoat / channel selectors / specularTint /
//   specularTintTexture …) appear without per-field hand wiring.
//
// Resolution order for a material's effective parameter list:
//   1. the material's pass module → manifest paramSchema (factory-module
//      aliases applied, e.g. `forgeax_material::standard`);
//   2. known engine standard ids → DEFAULT_STANDARD_PBR_PARAM_SCHEMA
//      (offline/test fallback when no manifest is reachable);
//   3. the material's own `parameters` declarations overlaid by name
//      (authored custom-material contract);
//   4. values-only keys surface as inferred rows so nothing editable hides.

import { DEFAULT_STANDARD_PBR_PARAM_SCHEMA } from '@forgeax/engine-shader';
import type { ParamSchemaEntry } from '@forgeax/engine-types';

// ── Descriptor: the panel-facing union of shader-schema + asset-declared types ──

/** Normalized parameter descriptor. `type` covers the engine's
 *  MaterialParamType literals plus the asset-side 'bool' / 'texture' aliases
 *  (MaterialParameter.type) which have no ParamSchemaEntry equivalent. */
export interface MaterialParamDescriptor {
  readonly name: string;
  readonly type: string;
  readonly default?: unknown;
  readonly colorSpace?: 'srgb' | 'linear';
}

// ── Manifest index ──────────────────────────────────────────────────────────

/** Factory-created materials carry the WGSL import path as their pass module;
 *  the manifest keys engine shaders by reserved identifier. */
const ENGINE_MODULE_ALIASES: Readonly<Record<string, string>> = {
  'forgeax_material::standard': 'forgeax::default-standard-pbr',
  'forgeax_material::pbr-skin': 'forgeax::pbr-skin',
  'forgeax_material::unlit': 'forgeax::default-unlit',
  'forgeax_material::sprite': 'forgeax::sprite',
  'forgeax_material::sprite-lit': 'forgeax::sprite-lit',
};

/** Ids that share the standard PBR contract when no manifest is reachable
 *  (tests, headless). pbr-skin ships the identical paramSchema (R-10). */
const STANDARD_PBR_FALLBACK_IDS: ReadonlySet<string> = new Set([
  'forgeax::default-standard-pbr',
  'forgeax::pbr-skin',
  'forgeax::default-standard-pbr-skin',
  'forgeax_material::standard',
  'forgeax_material::pbr-skin',
]);

export type ShaderParamSchemaIndex = ReadonlyMap<string, readonly ParamSchemaEntry[]>;

function isParamSchemaEntry(value: unknown): value is ParamSchemaEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as { name?: unknown; type?: unknown };
  return typeof entry.name === 'string' && entry.name.length > 0 && typeof entry.type === 'string';
}

/** Parse the shader manifest's materialShaders[] into identifier → paramSchema.
 *  Malformed entries are skipped (one bad shader must not blank the panel). */
export function parseShaderParamSchemaIndex(manifest: unknown): Map<string, readonly ParamSchemaEntry[]> {
  const index = new Map<string, readonly ParamSchemaEntry[]>();
  if (typeof manifest !== 'object' || manifest === null) return index;
  const materialShaders = (manifest as { materialShaders?: unknown }).materialShaders;
  if (!Array.isArray(materialShaders)) return index;
  for (const raw of materialShaders) {
    if (typeof raw !== 'object' || raw === null) continue;
    const { identifier, paramSchema } = raw as { identifier?: unknown; paramSchema?: unknown };
    if (typeof identifier !== 'string' || typeof paramSchema !== 'string') continue;
    try {
      const parsed: unknown = JSON.parse(paramSchema);
      if (!Array.isArray(parsed)) continue;
      index.set(identifier, parsed.filter(isParamSchemaEntry));
    } catch { /* malformed JSON — skip this shader */ }
  }
  return index;
}

let indexCache: Promise<ShaderParamSchemaIndex> | null = null;

/** Fetch + cache the shader manifest's paramSchema index (same base-aware URL
 *  the preview viewport boots with). Failures resolve to an EMPTY index and
 *  drop the cache so a later call can retry — resolveMaterialParamSchema's
 *  built-in fallback still covers the standard shaders in the meantime. */
export function ensureShaderParamSchemaIndex(): Promise<ShaderParamSchemaIndex> {
  if (indexCache === null) {
    const base = ((import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/')
      .replace(/\/$/u, '');
    indexCache = globalThis
      .fetch(`${base}/shaders/manifest.json`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`manifest HTTP ${res.status}`))))
      .then((json: unknown) => parseShaderParamSchemaIndex(json) as ShaderParamSchemaIndex)
      .catch(() => {
        indexCache = null;
        return new Map<string, readonly ParamSchemaEntry[]>();
      });
  }
  return indexCache;
}

/** Test hook: drop the cached manifest index. */
export function resetShaderParamSchemaIndexCache(): void {
  indexCache = null;
}

// ── Effective schema for one material ───────────────────────────────────────

interface PassDesc {
  readonly program?: { readonly module?: unknown };
}

function passModules(payload: Record<string, unknown>): string[] {
  const passes = payload.passes;
  if (!Array.isArray(passes)) return [];
  const modules: string[] = [];
  for (const pass of passes as PassDesc[]) {
    const module = pass?.program?.module;
    if (typeof module === 'string' && module.length > 0) modules.push(module);
  }
  return modules;
}

/** The material's own `parameters` declarations (authored custom-material
 *  contract), normalized to descriptors. */
function declaredParameters(payload: Record<string, unknown>): MaterialParamDescriptor[] {
  const parameters = payload.parameters;
  if (!Array.isArray(parameters)) return [];
  const out: MaterialParamDescriptor[] = [];
  for (const raw of parameters) {
    if (typeof raw !== 'object' || raw === null) continue;
    const p = raw as { name?: unknown; type?: unknown; default?: unknown; colorSpace?: unknown };
    if (typeof p.name !== 'string' || p.name.length === 0 || typeof p.type !== 'string') continue;
    out.push({
      name: p.name,
      type: p.type,
      ...(p.default !== undefined ? { default: p.default } : {}),
      ...(p.colorSpace === 'srgb' || p.colorSpace === 'linear' ? { colorSpace: p.colorSpace } : {}),
    });
  }
  return out;
}

/** Resolve the effective parameter descriptor list for a material payload.
 *  Shader schema first (manifest → built-in fallback), then the material's own
 *  `parameters` overlaid by name (declared wins on type/default conflicts). */
export function resolveMaterialParamSchema(
  payload: Record<string, unknown>,
  index: ShaderParamSchemaIndex | undefined,
): { descriptors: MaterialParamDescriptor[]; declaredNames: Set<string> } {
  const byName = new Map<string, MaterialParamDescriptor>();

  for (const module of passModules(payload)) {
    const schema = index?.get(module) ?? index?.get(ENGINE_MODULE_ALIASES[module] ?? '');
    if (schema !== undefined) {
      for (const entry of schema) byName.set(entry.name, entry);
      break;
    }
    if (STANDARD_PBR_FALLBACK_IDS.has(module)) {
      for (const entry of DEFAULT_STANDARD_PBR_PARAM_SCHEMA) byName.set(entry.name, entry);
      break;
    }
  }

  const declared = declaredParameters(payload);
  for (const entry of declared) byName.set(entry.name, entry);
  return { descriptors: [...byName.values()], declaredNames: new Set(declared.map((d) => d.name)) };
}

// ── Row derivation ──────────────────────────────────────────────────────────

export type MaterialParamRowKind = 'color' | 'scalar' | 'vector' | 'bool' | 'texture' | 'readonly';

export interface MaterialParamRow {
  readonly name: string;
  readonly kind: MaterialParamRowKind;
  /** Vector component count (2|3|4); 0 for non-vector kinds. */
  readonly components: number;
  /** Effective value: resolved (parent-chain merged) value, else the default. */
  readonly value: unknown;
  readonly defaultValue: unknown;
  /** Texture rows: resolved texture GUID (null = unassigned). */
  readonly textureGuid: string | null;
  readonly colorSpace: 'srgb' | 'linear';
  /** Scalar rows: true when a 0..1 slider is a sensible editor (unit default). */
  readonly slider: boolean;
  /** True when the material's OWN values carry the key (vs inherited/default). */
  readonly overridden: boolean;
  readonly source: 'shader' | 'declared' | 'value';
}

/** Resolve a stored texture value to its GUID. Pack format stores refs[]
 *  indices (number); the loaded/live form uses GUID strings; the glTF bridge
 *  nests it as `{ texture: guid|index }`. */
export function resolveTextureRefGuid(value: unknown, refs: readonly string[]): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isInteger(value)) return refs[value] ?? null;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const texture = (value as { texture?: unknown }).texture;
    if (typeof texture === 'string' && texture.length > 0) return texture;
    if (typeof texture === 'number' && Number.isInteger(texture)) return refs[texture] ?? null;
  }
  return null;
}

const VECTOR_COMPONENTS: Readonly<Record<string, number>> = { vec2: 2, vec3: 3, vec4: 4 };
const TEXTURE_TYPES: ReadonlySet<string> = new Set([
  'texture', 'texture2d', 'texture_cube', 'texture_depth_2d', 'texture_cube_array',
]);
const SCALAR_TYPES: ReadonlySet<string> = new Set(['f32', 'i32', 'u32']);

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'number');
}

function looksLikeTextureValue(name: string, value: unknown): boolean {
  if (/texture$/iu.test(name)) return true;
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && 'texture' in (value as Record<string, unknown>);
}

function unitRangeSlider(name: string, defaultValue: unknown, value: unknown): boolean {
  // Channel selectors (metallicChannel etc.) are 0..3 enum-ish indices, and
  // intensity-style params exceed 1 — a 0..1 slider misleads both.
  if (/channel$|intensity$|cutoff$/iu.test(name)) return false;
  const anchor = typeof defaultValue === 'number' ? defaultValue : value;
  return typeof anchor === 'number' && anchor >= 0 && anchor <= 1;
}

function descriptorRow(
  descriptor: MaterialParamDescriptor,
  source: MaterialParamRow['source'],
  own: Record<string, unknown>,
  resolved: Record<string, unknown>,
  refs: readonly string[],
  assetColorSpace: 'srgb' | 'linear',
): MaterialParamRow {
  const value = resolved[descriptor.name] ?? descriptor.default;
  const base = {
    name: descriptor.name,
    value,
    defaultValue: descriptor.default,
    overridden: descriptor.name in own,
    source,
  };
  if (TEXTURE_TYPES.has(descriptor.type)) {
    return {
      ...base, kind: 'texture', components: 0,
      textureGuid: resolveTextureRefGuid(resolved[descriptor.name], refs),
      colorSpace: assetColorSpace, slider: false,
    };
  }
  // A vector entry tagged with a colorSpace is an authored color (the standard
  // schema's emissive / specularTint are vec3+srgb) — edit it with a color
  // picker, not three bare number boxes.
  if (descriptor.type === 'color' || (descriptor.type in VECTOR_COMPONENTS && descriptor.colorSpace !== undefined)) {
    return {
      ...base, kind: 'color',
      components: descriptor.type === 'color' ? 4 : VECTOR_COMPONENTS[descriptor.type]!,
      textureGuid: null,
      colorSpace: descriptor.colorSpace ?? assetColorSpace, slider: false,
    };
  }
  if (descriptor.type in VECTOR_COMPONENTS) {
    return {
      ...base, kind: 'vector', components: VECTOR_COMPONENTS[descriptor.type]!, textureGuid: null,
      colorSpace: descriptor.colorSpace ?? assetColorSpace, slider: false,
    };
  }
  if (SCALAR_TYPES.has(descriptor.type)) {
    return {
      ...base, kind: 'scalar', components: 0, textureGuid: null,
      colorSpace: assetColorSpace,
      slider: unitRangeSlider(descriptor.name, descriptor.default, value),
    };
  }
  if (descriptor.type === 'bool') {
    return {
      ...base, kind: 'bool', components: 0, textureGuid: null,
      colorSpace: assetColorSpace, slider: false,
    };
  }
  return {
    ...base, kind: 'readonly', components: 0, textureGuid: null,
    colorSpace: assetColorSpace, slider: false,
  };
}

function inferredRow(
  name: string,
  own: Record<string, unknown>,
  resolved: Record<string, unknown>,
  refs: readonly string[],
  assetColorSpace: 'srgb' | 'linear',
): MaterialParamRow {
  const value = resolved[name];
  const base = {
    name, value, defaultValue: undefined,
    overridden: name in own, source: 'value' as const,
    colorSpace: assetColorSpace,
  };
  if (looksLikeTextureValue(name, value)) {
    return { ...base, kind: 'texture', components: 0, textureGuid: resolveTextureRefGuid(value, refs), slider: false };
  }
  if (typeof value === 'boolean') {
    return { ...base, kind: 'bool', components: 0, textureGuid: null, slider: false };
  }
  if (typeof value === 'number') {
    return { ...base, kind: 'scalar', components: 0, textureGuid: null, slider: unitRangeSlider(name, undefined, value) };
  }
  if (isNumberArray(value) && value.length >= 2 && value.length <= 4) {
    return { ...base, kind: 'vector', components: value.length, textureGuid: null, slider: false };
  }
  return { ...base, kind: 'readonly', components: 0, textureGuid: null, slider: false };
}

/** Derive the panel's row model: shader/declared descriptors in schema order,
 *  then values-only keys (sorted) as inferred rows. */
export function deriveMaterialParamRows(args: {
  readonly descriptors: readonly MaterialParamDescriptor[];
  readonly declaredNames: ReadonlySet<string>;
  readonly ownValues: Record<string, unknown>;
  readonly resolvedValues: Record<string, unknown>;
  readonly refs: readonly string[];
  readonly colorSpace: 'srgb' | 'linear';
}): MaterialParamRow[] {
  const { descriptors, declaredNames, ownValues, resolvedValues, refs, colorSpace } = args;
  const rows: MaterialParamRow[] = [];
  const covered = new Set<string>();

  for (const descriptor of descriptors) {
    covered.add(descriptor.name);
    rows.push(descriptorRow(
      descriptor,
      declaredNames.has(descriptor.name) ? 'declared' : 'shader',
      ownValues, resolvedValues, refs, colorSpace,
    ));
  }

  for (const name of Object.keys(resolvedValues).sort()) {
    if (covered.has(name)) continue;
    rows.push(inferredRow(name, ownValues, resolvedValues, refs, colorSpace));
  }
  return rows;
}
