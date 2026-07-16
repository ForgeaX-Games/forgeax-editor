// schema.ts — engine-reflected component schema registry
//
// ALL component schemas are derived AT RUNTIME from the engine's ECS introspection
// APIs (getRegisteredComponents → Component.fields → FieldReflection).
// Zero hand-maintained REGISTRY — the engine IS the single source of truth.
//
// Component filtering:
//   - transient components                    → excluded
//   - RELATIONSHIP_COMPONENTS (ChildOf, …)    → excluded
//   - explicit exclude list (Entity, Skin, …) → excluded
//
// Field type mapping (engine → editor):
//   f32 / u32 / i32 → number   |  array<f32, N> → vec (arity=N)
//   bool             → bool    |  shared<T>      → asset
//   string           → string  |  enum            → number (labels in tooltip)
//   entity refs      → excluded (internal handles)

import type {
  Component,
  FieldReflection,
  SchemaFieldType,
} from '@forgeax/engine-ecs';
import { getRegisteredComponents, RELATIONSHIP_COMPONENTS } from '@forgeax/engine-ecs';

// ═══════════════════════════════════════════════════════════════════════════════
// Public types (unchanged API surface)
// ═══════════════════════════════════════════════════════════════════════════════

export type FieldType = 'number' | 'string' | 'color' | 'asset' | 'bool' | 'enum' | 'vec';

export interface FieldSchema {
  key: string;
  type: FieldType;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  tooltip?: string;
  default?: unknown;
  showWhen?: { key: string; in: string[] };
  arity?: number;
  labels?: string[];
}

export interface ComponentSchema {
  name: string;
  fields: FieldSchema[];
  bespoke?: { editorId: string; hint?: string };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Editor-level overrides — only where engine schema alone can't infer the right
// editor rendering hint (e.g. 'color' vs 'vec', showWhen rules, tooltips).
// Keys: "ComponentName.fieldKey"
// ═══════════════════════════════════════════════════════════════════════════════

const EDITOR_FIELD_OVERRIDES: Record<string, Partial<FieldSchema>> = {
  // Transform — quat SSOT, euler is Inspector overlay only
  'Transform.quat': { tooltip: 'rotation quaternion [x, y, z, w] (SSOT, euler is Inspector overlay)' },
  // Sphere/capsule fields surfaced as tooltips on the vec fields
  'Collider.radius': { tooltip: 'sphere / capsule radius' },
  'Collider.halfHeight': { tooltip: 'capsule half-height (without caps)' },
  // Editor defaults where engine has none (engine schema omits defaults that
  // the runtime fills via factory functions, e.g. perspective() / orthographic())
  'MeshFilter.assetHandle': { default: 1, tooltip: 'shared mesh asset handle (built-in or imported)' }, // HANDLE_CUBE
  'Camera.fov': { default: 60 },
  'Camera.near': { default: 0.1 },
  'Camera.far': { default: 1000 },
  'DirectionalLight.direction': { default: [-0.4, -1, -0.3] },
  'SpotLight.direction': { default: [-0.4, -1, -0.3] },
  // Camera — ortho bounds visible only in orthographic mode
  'Camera.left':   { showWhen: { key: 'projection', in: ['1'] } },
  'Camera.right':  { showWhen: { key: 'projection', in: ['1'] } },
  'Camera.bottom': { showWhen: { key: 'projection', in: ['1'] } },
  'Camera.top':    { showWhen: { key: 'projection', in: ['1'] } },
  // DirectionalLight shadow fields visible when castShadow=true
  'DirectionalLight.cascadeCount':      { showWhen: { key: 'castShadow', in: ['true'] } },
  'DirectionalLight.splitLambda':       { showWhen: { key: 'castShadow', in: ['true'] } },
  'DirectionalLight.cascadeBlend':      { showWhen: { key: 'castShadow', in: ['true'] } },
  'DirectionalLight.mapSize':           { showWhen: { key: 'castShadow', in: ['true'] } },
  'DirectionalLight.depthBias':         { showWhen: { key: 'castShadow', in: ['true'] } },
  'DirectionalLight.normalBias':        { showWhen: { key: 'castShadow', in: ['true'] } },
  'DirectionalLight.shadowDistance':    { showWhen: { key: 'castShadow', in: ['true'] } },
  'DirectionalLight.pcfKernelSize':     { showWhen: { key: 'castShadow', in: ['true'] } },
  // SpotLight shadow fields
  'SpotLight.mapSize':        { showWhen: { key: 'castShadow', in: ['true'] } },
  'SpotLight.depthBias':      { showWhen: { key: 'castShadow', in: ['true'] } },
  'SpotLight.normalBias':     { showWhen: { key: 'castShadow', in: ['true'] } },
  'SpotLight.nearPlane':      { showWhen: { key: 'castShadow', in: ['true'] } },
  'SpotLight.farPlane':       { showWhen: { key: 'castShadow', in: ['true'] } },
  'SpotLight.pcfKernelSize':  { showWhen: { key: 'castShadow', in: ['true'] } },
  // SpriteRegionOverride — custom axis labels + editor default (engine has none)
  'SpriteRegionOverride.region': { labels: ['uMin', 'vMin', 'uW', 'vH'], default: [0, 0, 1, 1] },
};

// ═══════════════════════════════════════════════════════════════════════════════
// Explicit engine component exclude list
// ═══════════════════════════════════════════════════════════════════════════════

const EXCLUDED_COMPONENTS = new Set([
  'Entity',            // essential id=0, every entity has it
  'Name',              // Inspector renders via NameField component
  'SceneInstance',     // transient, engine scene loading creates it
  'CollidingEntities', // transient, physics engine writes per-frame
  'Skin',              // GLB import workflow, not addable
  'Tilemap',           // specialized tilemap editor workflow
  'TileLayer',         // depends on Tilemap
  'SpriteAnimation',   // variable-length per-frame UV regions
  'SpriteInstances',   // variable-length batch render data (per-instance mat4)
  'Instances',         // variable-length batch render data
  'PostProcessParams', // programmatic shader + buffer data
]);

// ═══════════════════════════════════════════════════════════════════════════════
// Lazy cache — populated on first query from engine introspection
// ═══════════════════════════════════════════════════════════════════════════════

let _cache: Map<string, ComponentSchema> | null = null;

function ensurePopulated(): Map<string, ComponentSchema> {
  if (_cache !== null) return _cache;
  _cache = new Map();
  try {
    const registry = getRegisteredComponents();
    for (const [name, comp] of registry) {
      if (shouldExclude(name, comp)) continue;
      const schema = reflectComponent(comp);
      if (schema !== null) _cache.set(name, schema);
    }
  } catch {
    // Engine not loaded yet (SSR, headless, unit tests w/o engine boot) —
    // the cache stays empty, queries return undefined.
  }
  return _cache;
}

/** Reset the cache (test-only). Not on the public barrel. */
export function _resetSchemaCache(): void {
  _cache = null;
}

function shouldExclude(name: string, comp: Component): boolean {
  if (comp.transient) return true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((RELATIONSHIP_COMPONENTS as ReadonlySet<any>).has(comp)) return true;
  if (EXCLUDED_COMPONENTS.has(name)) return true;
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Engine → Editor field type mapping
// ═══════════════════════════════════════════════════════════════════════════════

/** Exact engine field types that should NOT appear in the editor schema. */
const INTERNAL_FIELD_TYPES = new Set<SchemaFieldType>([
  'entity',        // internal entity handle
  'array<entity>', // internal entity array
]);

/** Prefix patterns for parametric types that are editor-internal. */
function isInternalFieldType(engineType: SchemaFieldType): boolean {
  if (INTERNAL_FIELD_TYPES.has(engineType)) return true;
  // `unique<T>` is a template literal SchemaFieldType — match by prefix, not Set membership
  if (engineType.startsWith('unique<')) return true;
  return false;
}

function mapFieldType(engineType: SchemaFieldType): FieldType | null {
  // shared<T> → asset
  if (engineType.startsWith('shared<')) return 'asset';
  if (engineType.startsWith('array<shared<')) return 'asset';
  // array<f32, N> → vec
  if (engineType.startsWith('array<f32,')) return 'vec';
  // Basic scalars
  if (engineType === 'f32' || engineType === 'u32' || engineType === 'i32') return 'number';
  if (engineType === 'bool') return 'bool';
  if (engineType === 'string') return 'string';
  // enum → number (engine stores u32; labels documented in tooltip)
  if (engineType === 'enum') return 'number';
  // Internal types
  if (isInternalFieldType(engineType)) return null;
  // Unknown / variable-length array → skip
  return null;
}

/** Extract arity from 'array<f32, N>' schema type. */
function extractVecArity(engineType: SchemaFieldType): number | undefined {
  const m = engineType.match(/^array<f32,\s*(\d+)>$/);
  return m ? Number(m[1]) : undefined;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Reflection: one engine Component → one editor ComponentSchema
// ═══════════════════════════════════════════════════════════════════════════════

function reflectComponent(comp: Component): ComponentSchema | null {
  const { name, fields, defaults } = comp;
  const editorFields: FieldSchema[] = [];

  for (const [fieldKey, reflection] of Object.entries(fields) as [string, FieldReflection][]) {
    // Skip field-level transient fields (engine-derived, e.g. Transform.world)
    if (reflection.transient) continue;

    const editorType = mapFieldType(reflection.type);
    if (editorType === null) continue;

    // Compute arity for vec fields BEFORE building the default (needed for
    // correct-length zero-fill when the engine supplies no explicit default).
    const arity = editorType === 'vec' ? (extractVecArity(reflection.type) ?? 3) : undefined;

    const field: FieldSchema = {
      key: fieldKey,
      type: editorType,
      tooltip: buildTooltip(fieldKey, editorType, reflection),
      default: deriveDefault(editorType, arity, reflection, defaults?.[fieldKey]),
      ...(arity !== undefined ? { arity } : {}),
      ...deriveConstraints(editorType, fieldKey, reflection),
    };

    // Apply editor-level overrides (showWhen, labels, tooltips, defaults, etc.)
    const overrideKey = `${name}.${fieldKey}`;
    const overrides = EDITOR_FIELD_OVERRIDES[overrideKey];
    if (overrides) Object.assign(field, overrides);

    editorFields.push(field);
  }

  if (editorFields.length === 0) return null;
  return { name, fields: editorFields };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tooltip generation from engine metadata
// ═══════════════════════════════════════════════════════════════════════════════

function buildTooltip(fieldKey: string, editorType: FieldType, r: FieldReflection): string {
  // enum fields: document labels→value mapping
  if (r.type === 'enum' && r.labels) {
    const entries = Object.entries(r.labels)
      .map(([label, value]) => `${value}=${label}`)
      .join(', ');
    return `${fieldKey}: ${entries}`;
  }
  if (editorType === 'asset') return `${fieldKey} (${r.type})`;
  if (editorType === 'vec') return `${fieldKey} [${r.type}]`;
  return `${fieldKey} (${r.type})`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Default value derivation (engine → editor)
// ═══════════════════════════════════════════════════════════════════════════════

function deriveDefault(
  editorType: FieldType,
  arity: number | undefined,
  reflection: FieldReflection,
  compDefault?: unknown,
): unknown {
  // Component-level default takes priority
  if (compDefault !== undefined) return coerceDefault(editorType, compDefault);
  // Field-level default
  if (reflection.default !== undefined) return coerceDefault(editorType, reflection.default);
  // array<shared<T>> fields default to empty array (not 0)
  if (reflection.arrayMeta) return [];
  // vec fields without explicit default: zero-fill to arity
  if (editorType === 'vec') return new Array(arity ?? 3).fill(0);
  // Type-derived fallback
  return defaultFieldValueInternal(editorType);
}

/** Coerce engine default to editor-friendly form
 *  (Float32Array → number[], BigInt → number, etc.) */
function coerceDefault(editorType: FieldType, value: unknown): unknown {
  if (value instanceof Float32Array) return Array.from(value);
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' && !Number.isFinite(value)) return 0;
  return value;
}

function defaultFieldValueInternal(type: FieldType): unknown {
  switch (type) {
    case 'number': return 0;
    case 'vec':    return [0, 0, 0];
    case 'bool':   return false;
    case 'string': return '';
    case 'asset':  return 0;
    default:       return 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Constraint derivation (min/max/step) from type + field name heuristics
// ═══════════════════════════════════════════════════════════════════════════════

const VEC_COLOR_FIELDS = new Set(['color', 'clearColor']);

function deriveConstraints(
  editorType: FieldType,
  fieldKey: string,
  _reflection: FieldReflection,
): Partial<Pick<FieldSchema, 'min' | 'max' | 'step'>> {
  if (editorType === 'vec') {
    if (VEC_COLOR_FIELDS.has(fieldKey)) return { min: 0, step: 0.1 };
    return { step: 0.1 };
  }
  if (editorType === 'number') {
    // Heuristic step based on field name
    const step = fieldKey.includes('Deg') ? 1 :
                fieldKey.includes('Bias') ? 0.001 :
                fieldKey.includes('Intensity') || fieldKey.includes('Damping') ? 0.01 :
                fieldKey.includes('Scale') || fieldKey.includes('Density') ? 0.1 :
                1;
    return { step };
  }
  return {};
}

// ═══════════════════════════════════════════════════════════════════════════════
// Public API (unchanged signatures)
// ═══════════════════════════════════════════════════════════════════════════════

export function getComponentSchema(name: string): ComponentSchema | undefined {
  return ensurePopulated().get(name);
}

export function fieldSchema(component: string, key: string): FieldSchema | undefined {
  return getComponentSchema(component)?.fields.find((f) => f.key === key);
}

export function listComponentSchemas(): ComponentSchema[] {
  return [...ensurePopulated().values()];
}

export function defaultFieldValue(fs: FieldSchema): unknown {
  if (fs.default !== undefined) return fs.default;
  return defaultFieldValueInternal(fs.type);
}

export function defaultComponentData(name: string): Record<string, unknown> {
  const cs = getComponentSchema(name);
  if (!cs) return {};
  const out: Record<string, unknown> = {};
  for (const f of cs.fields) out[f.key] = defaultFieldValue(f);
  return out;
}

export function fieldVisible(
  component: string,
  fs: FieldSchema | undefined,
  data: Record<string, unknown>,
): boolean {
  if (!fs?.showWhen) return true;
  let cur = data[fs.showWhen.key];
  if (cur === undefined || cur === null) cur = fieldSchema(component, fs.showWhen.key)?.options?.[0];
  return fs.showWhen.in.includes(String(cur));
}

export function clampToField(fs: FieldSchema | undefined, n: number): number {
  if (!fs) return n;
  let v = n;
  if (fs.min !== undefined) v = Math.max(fs.min, v);
  if (fs.max !== undefined) v = Math.min(fs.max, v);
  return v;
}
