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
// plan-strategy S2 D-2: Transform quatX/Y/Z/W SSOT, euler in Inspector only
// plan-strategy S2 D-3: Light scheme A (three independent components)
// research F-EngineComponents: field names verbatim from engine submodule

export type FieldType = 'number' | 'string' | 'color' | 'asset' | 'bool' | 'enum';

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
  // ── Transform: engine-native quatX/Y/Z/W + posX/Y/Z + scaleX/Y/Z ─────────────
  // Engine: transform.ts:71 defineComponent
  // `world` (mat4) is engine-derived column — excluded from editor schema (D-2).
  // Euler (rotX/rotY/rotZ) is Inspector React state only, NOT in schema/world.
  Transform: {
    name: 'Transform',
    fields: [
      { key: 'posX', type: 'number', step: 0.1 },
      { key: 'posY', type: 'number', step: 0.1 },
      { key: 'posZ', type: 'number', step: 0.1 },
      { key: 'quatX', type: 'number', step: 0.01, default: 0, tooltip: 'rotation quaternion X (SSOT, euler is Inspector overlay)' },
      { key: 'quatY', type: 'number', step: 0.01, default: 0, tooltip: 'rotation quaternion Y (SSOT, euler is Inspector overlay)' },
      { key: 'quatZ', type: 'number', step: 0.01, default: 0, tooltip: 'rotation quaternion Z (SSOT, euler is Inspector overlay)' },
      { key: 'quatW', type: 'number', step: 0.01, default: 1, tooltip: 'rotation quaternion W (SSOT, euler is Inspector overlay)' },
      { key: 'scaleX', type: 'number', step: 0.1, default: 1, tooltip: 'scale along X (box width)' },
      { key: 'scaleY', type: 'number', step: 0.1, default: 1, tooltip: 'scale along Y (box height)' },
      { key: 'scaleZ', type: 'number', step: 0.1, default: 1, tooltip: 'scale along Z (box depth)' },
    ],
  },
  // ── MeshFilter: engine-native assetHandle (replaces Mesh{kind}) ──────────────
  // Engine: mesh-filter.ts:57 defineComponent { assetHandle: shared<MeshAsset> }
  MeshFilter: {
    name: 'MeshFilter',
    fields: [
      { key: 'assetHandle', type: 'asset', tooltip: 'shared mesh asset handle (built-in or imported)' },
    ],
  },
  // ── MeshRenderer: engine-native materials[] (replaces Material) ───────────────
  // Engine: mesh-renderer.ts:59 defineComponent
  MeshRenderer: {
    name: 'MeshRenderer',
    fields: [
      { key: 'materials', type: 'asset', tooltip: 'array of shared MaterialAsset handles' },
    ],
  },
  // ── DirectionalLight: engine-native per-channel scalars ──────────────────────
  // Engine: directional-light.ts:92 defineComponent (directionX/Y/Z, colorR/G/B, intensity, castShadow)
  DirectionalLight: {
    name: 'DirectionalLight',
    fields: [
      { key: 'directionX', type: 'number', step: 0.05, default: -0.4, tooltip: 'direction X' },
      { key: 'directionY', type: 'number', step: 0.05, default: -1, tooltip: 'direction Y' },
      { key: 'directionZ', type: 'number', step: 0.05, default: -0.3, tooltip: 'direction Z' },
      { key: 'colorR', type: 'number', min: 0, step: 0.1, default: 1, tooltip: 'red channel (linear, HDR)' },
      { key: 'colorG', type: 'number', min: 0, step: 0.1, default: 1, tooltip: 'green channel (linear, HDR)' },
      { key: 'colorB', type: 'number', min: 0, step: 0.1, default: 1, tooltip: 'blue channel (linear, HDR)' },
      { key: 'intensity', type: 'number', min: 0, max: 50, step: 0.1, default: 1, tooltip: 'radiant intensity (HDR magnitude)' },
      { key: 'castShadow', type: 'bool', tooltip: 'whether this light casts shadows' },
    ],
  },
  // ── PointLight: engine-native per-channel + range ────────────────────────────
  // Engine: point-light.ts:56 defineComponent
  PointLight: {
    name: 'PointLight',
    fields: [
      { key: 'colorR', type: 'number', min: 0, step: 0.1, default: 1, tooltip: 'red channel (linear, HDR)' },
      { key: 'colorG', type: 'number', min: 0, step: 0.1, default: 1, tooltip: 'green channel (linear, HDR)' },
      { key: 'colorB', type: 'number', min: 0, step: 0.1, default: 1, tooltip: 'blue channel (linear, HDR)' },
      { key: 'intensity', type: 'number', min: 0, max: 50, step: 0.1, default: 1, tooltip: 'radiant intensity (HDR magnitude)' },
      { key: 'range', type: 'number', min: 0, max: 100, step: 0.5, default: 10, tooltip: 'falloff distance (world units)' },
    ],
  },
  // ── SpotLight: engine-native cone + per-channel ─────────────────────────────
  // Engine: spot-light.ts:102 defineComponent
  SpotLight: {
    name: 'SpotLight',
    fields: [
      { key: 'directionX', type: 'number', step: 0.05, default: -0.4, tooltip: 'direction X' },
      { key: 'directionY', type: 'number', step: 0.05, default: -1, tooltip: 'direction Y' },
      { key: 'directionZ', type: 'number', step: 0.05, default: -0.3, tooltip: 'direction Z' },
      { key: 'colorR', type: 'number', min: 0, step: 0.1, default: 1, tooltip: 'red channel (linear, HDR)' },
      { key: 'colorG', type: 'number', min: 0, step: 0.1, default: 1, tooltip: 'green channel (linear, HDR)' },
      { key: 'colorB', type: 'number', min: 0, step: 0.1, default: 1, tooltip: 'blue channel (linear, HDR)' },
      { key: 'intensity', type: 'number', min: 0, max: 50, step: 0.1, default: 1, tooltip: 'radiant intensity (HDR magnitude)' },
      { key: 'range', type: 'number', min: 0, max: 100, step: 0.5, default: 10, tooltip: 'falloff distance (world units)' },
      { key: 'innerConeDeg', type: 'number', min: 0, max: 90, step: 1, default: 0, tooltip: 'inner cone half-angle (degrees)' },
      { key: 'outerConeDeg', type: 'number', min: 1, max: 90, step: 1, default: 45, tooltip: 'outer cone half-angle (degrees)' },
      { key: 'castShadow', type: 'bool', tooltip: 'whether this light casts shadows' },
    ],
  },
  // ── Camera: engine-native fields ─────────────────────────────────────────────
  // Engine: camera.ts:295 defineComponent (fov, aspect, near, far, projection, ...)
  Camera: {
    name: 'Camera',
    fields: [
      { key: 'projection', type: 'number', step: 1, min: 0, max: 1, default: 0, tooltip: '0=perspective, 1=orthographic' },
      { key: 'fov', type: 'number', min: 10, max: 120, step: 1, default: 60, tooltip: 'vertical field of view (degrees)' },
      { key: 'aspect', type: 'number', min: 0.1, max: 10, step: 0.01, tooltip: 'aspect ratio (auto if autoAspect=1)' },
      { key: 'near', type: 'number', min: 0.001, max: 100, step: 0.001, default: 0.1, tooltip: 'near clip plane' },
      { key: 'far', type: 'number', min: 1, max: 100000, step: 1, default: 1000, tooltip: 'far clip plane' },
    ],
  },
  // ── Collider: engine-native fields ───────────────────────────────────────────
  // Engine: physics/src/components.ts:150 defineComponent
  Collider: {
    name: 'Collider',
    fields: [
      { key: 'shape', type: 'number', min: 0, max: 2, step: 1, default: 0, tooltip: 'collision shape: 0=cuboid, 1=sphere, 2=capsule' },
      { key: 'halfExtentsX', type: 'number', min: 0, max: 50, step: 0.1, default: 0.5 },
      { key: 'halfExtentsY', type: 'number', min: 0, max: 50, step: 0.1, default: 0.5 },
      { key: 'halfExtentsZ', type: 'number', min: 0, max: 50, step: 0.1, default: 0.5 },
      { key: 'radius', type: 'number', min: 0, max: 50, step: 0.1, default: 0.5 },
      { key: 'halfHeight', type: 'number', min: 0, max: 50, step: 0.1, default: 0.5 },
      { key: 'friction', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: 'restitution', type: 'number', min: 0, max: 1, step: 0.01, default: 0 },
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
    case 'enum':
      return fs.options?.[0] ?? '';
    case 'bool':
      return false;
    case 'color':
      return '#cccccc';
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