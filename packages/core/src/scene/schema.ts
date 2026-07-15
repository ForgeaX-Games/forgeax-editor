// Component schema registry — the one place that "knows" what fields a component
// has and their constraints. The Inspector reflects it into widgets; the AI
// bridge reflects the SAME data into `getComponentSchema`. Add a component here
// → inspector + AI tool both cover it with zero bespoke UI.
//
// feat-20260701-editor-world-container-doc-ecs-collapse M3 / AC-22:
// REGISTRY rewritten to engine-verbatim component schemas. All field names
// match engine defineComponent fields exactly. Old editor-authored schemas
// (Mesh, Material, Light, Anim, MatGraph, GltfRef) deleted (M3 + M6 sweep).
//
// plan-strategy S2 D-2: Transform quat SSOT (array<f32,4>), euler in Inspector only
// plan-strategy S2 D-3: Light scheme A (three independent components)
// research F-EngineComponents: field names verbatim from engine submodule
//
// feat-20260709 (engine array-TRS): Transform's 10 per-axis scalar columns
// (posX/quatW/scaleZ…) collapsed to three engine `array<f32, N>` columns —
// `pos` (3), `quat` (4), `scale` (3). The schema models them as a single
// `'vec'` FieldType carrying `arity`; the Inspector renders one inline N-axis
// row per vec field, keyed by array index (not sibling scalar keys).

import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';

export type FieldType = 'number' | 'string' | 'color' | 'asset' | 'bool' | 'enum' | 'vec';

export interface FieldSchema {
  key: string;
  type: FieldType;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  tooltip?: string;
  // Sensible authoring default used when a component is freshly added / reset.
  // Falls back to a type-derived value (see defaultFieldValue) when omitted.
  default?: unknown;
  // Conditional visibility: only show this field when sibling `key` ∈ `in`.
  showWhen?: { key: string; in: string[] };
  // `vec` only: number of scalar axes (3 for pos/scale, 4 for a quaternion).
  // The Inspector renders `arity` inline number widgets; `labels` names each
  // axis (defaults to x/y/z/w). The default value is a length-`arity` array.
  arity?: number;
  labels?: string[];
}

export interface ComponentSchema {
  name: string;
  fields: FieldSchema[];
  /** Marks a "bespoke" component that has its own dedicated panel. The Inspector
   *  renders a minimal banner instead of raw field widgets; `editorId` names the
   *  dock panel that edits it (same id as in DockManager's TITLE map). */
  bespoke?: { editorId: string; hint?: string };
}

const REGISTRY: Record<string, ComponentSchema> = {
  // ── Transform: engine-native pos[3] + quat[4] + scale[3] (array-TRS) ──────────
  // Engine: transform.ts defineComponent (feat-20260709 array columns).
  // `world` (mat4) is an engine-derived transient column — excluded here (D-2).
  // Euler (rotX/rotY/rotZ) is Inspector React state only, NOT in schema/world;
  // it overlays the `quat` SSOT (array<f32,4>, [x,y,z,w]).
  Transform: {
    name: 'Transform',
    fields: [
      { key: 'pos', type: 'vec', arity: 3, step: 0.1, default: [0, 0, 0], tooltip: 'local position [x, y, z]' },
      { key: 'quat', type: 'vec', arity: 4, step: 0.01, default: [0, 0, 0, 1], tooltip: 'rotation quaternion [x, y, z, w] (SSOT, euler is Inspector overlay)' },
      { key: 'scale', type: 'vec', arity: 3, step: 0.1, default: [1, 1, 1], tooltip: 'local scale [x, y, z]' },
    ],
  },
  // ── MeshFilter: engine-native assetHandle (replaces Mesh{kind}) ──────────────
  // Engine: mesh-filter.ts:57 defineComponent { assetHandle: shared<MeshAsset> }
  MeshFilter: {
    name: 'MeshFilter',
    fields: [
      { key: 'assetHandle', type: 'asset', default: HANDLE_CUBE, tooltip: 'shared mesh asset handle (built-in or imported)' },
    ],
  },
  // ── MeshRenderer: engine-native materials[] (replaces Material) ───────────────
  // Engine: mesh-renderer.ts:59 defineComponent
  MeshRenderer: {
    name: 'MeshRenderer',
    fields: [
      { key: 'materials', type: 'asset', default: [], tooltip: 'array of shared MaterialAsset handles' },
    ],
  },
  // ── DirectionalLight: engine-native vec (feat-20260709 M2 direction/color collapse)
  // Engine: directional-light.ts defineComponent (direction[3], color[3], intensity, castShadow)
  DirectionalLight: {
    name: 'DirectionalLight',
    fields: [
      { key: 'direction', type: 'vec', arity: 3, step: 0.05, default: [-0.4, -1, -0.3], tooltip: 'direction [x, y, z]' },
      { key: 'color', type: 'vec', arity: 3, min: 0, step: 0.1, default: [1, 1, 1], tooltip: 'color [r, g, b] (linear, HDR)' },
      { key: 'intensity', type: 'number', min: 0, max: 50, step: 0.1, default: 1, tooltip: 'radiant intensity (HDR magnitude)' },
      { key: 'castShadow', type: 'bool', tooltip: 'whether this light casts shadows' },
    ],
  },
  // ── PointLight: engine-native vec color + range ──────────────────────────────
  // Engine: point-light.ts defineComponent (color[3], intensity, range)
  PointLight: {
    name: 'PointLight',
    fields: [
      { key: 'color', type: 'vec', arity: 3, min: 0, step: 0.1, default: [1, 1, 1], tooltip: 'color [r, g, b] (linear, HDR)' },
      { key: 'intensity', type: 'number', min: 0, max: 50, step: 0.1, default: 1, tooltip: 'radiant intensity (HDR magnitude)' },
      { key: 'range', type: 'number', min: 0, max: 100, step: 0.5, default: 10, tooltip: 'falloff distance (world units)' },
    ],
  },
  // ── SpotLight: engine-native cone + vec direction/color ──────────────────────
  // Engine: spot-light.ts defineComponent (direction[3], color[3], cone, ...)
  SpotLight: {
    name: 'SpotLight',
    fields: [
      { key: 'direction', type: 'vec', arity: 3, step: 0.05, default: [-0.4, -1, -0.3], tooltip: 'direction [x, y, z]' },
      { key: 'color', type: 'vec', arity: 3, min: 0, step: 0.1, default: [1, 1, 1], tooltip: 'color [r, g, b] (linear, HDR)' },
      { key: 'intensity', type: 'number', min: 0, max: 50, step: 0.1, default: 1, tooltip: 'radiant intensity (HDR magnitude)' },
      { key: 'range', type: 'number', min: 0, max: 100, step: 0.5, default: 10, tooltip: 'falloff distance (world units)' },
      { key: 'innerConeDeg', type: 'number', min: 0, max: 90, step: 1, default: 0, tooltip: 'inner cone half-angle (degrees)' },
      { key: 'outerConeDeg', type: 'number', min: 1, max: 90, step: 1, default: 45, tooltip: 'outer cone half-angle (degrees)' },
      { key: 'castShadow', type: 'bool', tooltip: 'whether this light casts shadows' },
    ],
  },
  // ── Camera: engine-native fields ─────────────────────────────────────────────
  // Engine: camera.ts defineComponent (fov, aspect, near, far, projection,
  // clearColor[4] — feat-20260709 M3 clear-color array<f32,4> collapse).
  Camera: {
    name: 'Camera',
    fields: [
      { key: 'projection', type: 'number', step: 1, min: 0, max: 1, default: 0, tooltip: '0=perspective, 1=orthographic' },
      { key: 'fov', type: 'number', min: 10, max: 120, step: 1, default: 60, tooltip: 'vertical field of view (degrees)' },
      { key: 'aspect', type: 'number', min: 0.1, max: 10, step: 0.01, tooltip: 'aspect ratio (auto if autoAspect=1)' },
      { key: 'near', type: 'number', min: 0.001, max: 100, step: 0.001, default: 0.1, tooltip: 'near clip plane' },
      { key: 'far', type: 'number', min: 1, max: 100000, step: 1, default: 1000, tooltip: 'far clip plane' },
      { key: 'clearColor', type: 'vec', arity: 4, min: 0, step: 0.05, default: [0, 0, 0, 1], tooltip: 'clear color [r, g, b, a] (linear)' },
    ],
  },
  // ── Collider: engine-native fields (halfExtents vec, feat-20260709) ──────────
  // Engine: physics/src/components.ts defineComponent (halfExtents[3], ...)
  Collider: {
    name: 'Collider',
    fields: [
      { key: 'shape', type: 'number', min: 0, max: 2, step: 1, default: 0, tooltip: 'collision shape: 0=cuboid, 1=sphere, 2=capsule' },
      { key: 'halfExtents', type: 'vec', arity: 3, min: 0, step: 0.1, default: [0.5, 0.5, 0.5], tooltip: 'cuboid half-extents [x, y, z]' },
      { key: 'radius', type: 'number', min: 0, max: 50, step: 0.1, default: 0.5 },
      { key: 'halfHeight', type: 'number', min: 0, max: 50, step: 0.1, default: 0.5 },
      { key: 'friction', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: 'restitution', type: 'number', min: 0, max: 1, step: 0.01, default: 0 },
    ],
  },
  // ── SpriteRegionOverride: engine-native per-entity sprite UV region ──────────
  // Engine: sprite-region-override.ts:104 defineComponent { region: array<f32,4> }
  SpriteRegionOverride: {
    name: 'SpriteRegionOverride',
    fields: [
      { key: 'region', type: 'vec', arity: 4, step: 0.01,
        default: [0, 0, 1, 1],
        labels: ['uMin', 'vMin', 'uW', 'vH'],
        tooltip: 'per-entity sprite UV region override [uMin, vMin, uWidth, vHeight]' },
    ],
  },
};

export function getComponentSchema(name: string): ComponentSchema | undefined {
  return REGISTRY[name];
}

export function fieldSchema(component: string, key: string): FieldSchema | undefined {
  return REGISTRY[component]?.fields.find((f) => f.key === key);
}

export function listComponentSchemas(): ComponentSchema[] {
  return Object.values(REGISTRY);
}

/** A schema-derived default value for a field (used when adding a component). */
export function defaultFieldValue(fs: FieldSchema): unknown {
  if (fs.default !== undefined) return fs.default;
  switch (fs.type) {
    case 'number':
      return fs.min ?? 0;
    case 'vec':
      // Identity-ish fallback: all-zero of the declared arity. Real vec fields
      // (pos/quat/scale) carry explicit `default` arrays above — this only
      // fires for a vec declared without one.
      return new Array(fs.arity ?? 3).fill(0);
    case 'enum':
      return fs.options?.[0] ?? '';
    case 'bool':
      return false;
    case 'color':
      return '#cccccc';
    case 'asset':
      return 0; // null handle — no asset assigned
    default:
      return '';
  }
}

/** Build a complete default component payload straight from its schema. */
export function defaultComponentData(name: string): Record<string, unknown> {
  const cs = REGISTRY[name];
  if (!cs) return {};
  const out: Record<string, unknown> = {};
  for (const f of cs.fields) out[f.key] = defaultFieldValue(f);
  return out;
}

/**
 * Whether a field should show given the component's current data (showWhen rule).
 * The controlling sibling may be absent on the instance (schema-completed UI), so
 * we fall back to that sibling's default (first enum option) when missing.
 */
export function fieldVisible(component: string, fs: FieldSchema | undefined, data: Record<string, unknown>): boolean {
  if (!fs?.showWhen) return true;
  let cur = data[fs.showWhen.key];
  if (cur === undefined || cur === null) cur = fieldSchema(component, fs.showWhen.key)?.options?.[0];
  return fs.showWhen.in.includes(String(cur));
}

/** Clamp a number to a field's [min,max] when defined (no-op otherwise). */
export function clampToField(fs: FieldSchema | undefined, n: number): number {
  if (!fs) return n;
  let v = n;
  if (fs.min !== undefined) v = Math.max(fs.min, v);
  if (fs.max !== undefined) v = Math.min(fs.max, v);
  return v;
}