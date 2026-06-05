// Component schema registry — the one place that "knows" what fields a component
// has and their constraints. The Inspector reflects it into widgets; the AI
// bridge reflects the SAME data into `getComponentSchema`. Add a component here
// → inspector + AI tool both cover it with zero bespoke UI.

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
  Transform: {
    name: 'Transform',
    fields: [
      { key: 'x', type: 'number', step: 0.1 },
      { key: 'y', type: 'number', step: 0.1 },
      { key: 'z', type: 'number', step: 0.1 },
      { key: 'scaleX', type: 'number', step: 0.1, default: 1, tooltip: 'scale along X (box width)' },
      { key: 'scaleY', type: 'number', step: 0.1, default: 1, tooltip: 'scale along Y (box height)' },
      { key: 'scaleZ', type: 'number', step: 0.1, default: 1, tooltip: 'scale along Z (box depth)' },
      { key: 'rotX', type: 'number', step: 1, default: 0, tooltip: 'rotation about X (degrees)' },
      { key: 'rotY', type: 'number', step: 1, default: 0, tooltip: 'rotation about Y (degrees)' },
      { key: 'rotZ', type: 'number', step: 1, default: 0, tooltip: 'rotation about Z (degrees)' },
    ],
  },
  Mesh: {
    name: 'Mesh',
    fields: [
      { key: 'kind', type: 'enum', options: ['cube', 'sphere', 'cylinder'], default: 'cube', tooltip: 'primitive geometry' },
    ],
  },
  Light: {
    name: 'Light',
    fields: [
      { key: 'type', type: 'enum', options: ['point', 'spot', 'directional'], tooltip: 'light source kind' },
      { key: 'intensity', type: 'number', min: 0, max: 50, step: 0.1, default: 1, tooltip: 'radiant intensity (HDR magnitude)' },
      { key: 'color', type: 'color', default: '#ffffff', tooltip: 'emitted light color (hue; magnitude in intensity)' },
      { key: 'range', type: 'number', min: 0, max: 100, step: 0.5, default: 0, tooltip: 'falloff distance (0 = infinite)', showWhen: { key: 'type', in: ['point', 'spot'] } },
      { key: 'directionX', type: 'number', step: 0.05, default: -0.4, tooltip: 'direction X', showWhen: { key: 'type', in: ['directional'] } },
      { key: 'directionY', type: 'number', step: 0.05, default: -1, tooltip: 'direction Y', showWhen: { key: 'type', in: ['directional'] } },
      { key: 'directionZ', type: 'number', step: 0.05, default: -0.3, tooltip: 'direction Z', showWhen: { key: 'type', in: ['directional'] } },
      { key: 'castShadow', type: 'bool', tooltip: 'whether this light casts shadows' },
      { key: 'spotAngle', type: 'number', min: 1, max: 90, step: 1, default: 30, tooltip: 'spot cone half-angle (degrees)', showWhen: { key: 'type', in: ['spot'] } },
    ],
  },
  Material: {
    name: 'Material',
    fields: [
      { key: 'materialAsset', type: 'asset', tooltip: '引用一个材质资产 (GUID);设置后覆盖下面的内联 PBR(留空则用内联)' },
      { key: 'albedo', type: 'color', default: '#cccccc' },
      { key: 'metallic', type: 'number', min: 0, max: 1, step: 0.01 },
      { key: 'roughness', type: 'number', min: 0, max: 1, step: 0.01, default: 0.8 },
      { key: 'emissive', type: 'color', default: '#000000', tooltip: 'emissive color (hue; magnitude in emissiveIntensity)' },
      { key: 'emissiveIntensity', type: 'number', min: 0, max: 8, step: 0.05, default: 1, tooltip: 'emissive HDR magnitude (glow strength)' },
      { key: 'shading', type: 'enum', options: ['standard', 'unlit'], default: 'standard', tooltip: 'standard = PBR lit; unlit = flat self-color' },
      { key: 'albedoMap', type: 'asset' },
      { key: 'normalMap', type: 'asset' },
      { key: 'ormMap', type: 'asset' },
    ],
  },
  Collider: {
    name: 'Collider',
    fields: [
      { key: 'shape', type: 'enum', options: ['none', 'box', 'cylinder'], default: 'none', tooltip: 'collision primitive (box = from scale; cylinder = radius)' },
      { key: 'radius', type: 'number', min: 0, max: 50, step: 0.1, default: 1, tooltip: 'cylinder radius', showWhen: { key: 'shape', in: ['cylinder'] } },
    ],
  },
  Velocity: {
    name: 'Velocity',
    fields: [
      { key: 'vx', type: 'number', step: 0.1, tooltip: 'units/tick along X' },
      { key: 'vy', type: 'number', step: 0.1, tooltip: 'units/tick along Y' },
      { key: 'vz', type: 'number', step: 0.1, tooltip: 'units/tick along Z' },
    ],
  },
  Spin: {
    name: 'Spin',
    fields: [{ key: 'speed', type: 'number', min: -90, max: 90, step: 1, default: 30, tooltip: 'yaw degrees per tick (Play mode)' }],
  },
  Camera: {
    name: 'Camera',
    fields: [
      { key: 'projection', type: 'enum', options: ['perspective', 'orthographic'], tooltip: 'camera projection model' },
      { key: 'fov', type: 'number', min: 10, max: 120, step: 1, default: 60, tooltip: 'vertical field of view (degrees)' },
      { key: 'near', type: 'number', min: 0.01, max: 100, step: 0.01, default: 0.1, tooltip: 'near clip plane' },
      { key: 'far', type: 'number', min: 1, max: 10000, step: 1, default: 1000, tooltip: 'far clip plane' },
    ],
  },
  // ── Bespoke components (design §17/§18 "编辑器扩展点") ─────────────────────
  // These are authored through dedicated panels (Timeline / Material Graph), not
  // the generic Inspector. The schema entry marks them as bespoke so:
  //  • the Inspector renders a minimal banner + link instead of raw field widgets;
  //  • `+ Component` / presets can still add the component by its default;
  //  • Capabilities panel documents them alongside the schema-driven components.
  Anim: {
    name: 'Anim',
    fields: [
      { key: 'duration', type: 'number', min: 0.1, max: 600, step: 0.1, default: 4, tooltip: 'clip length in seconds' },
    ],
    bespoke: { editorId: 'timeline', hint: 'Edit keyframes in the Timeline panel.' },
  },
  MatGraph: {
    name: 'MatGraph',
    fields: [],
    bespoke: { editorId: 'matgraph', hint: 'Build this material in the Mat Graph panel.' },
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
