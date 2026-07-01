// Entity creation presets — the UE/Unity "Create > Light/Camera/…" surface.
// Each preset only names its components; the payload is built from each
// component's SCHEMA defaults, so presets stay in sync as schemas evolve (zero
// bespoke field data) and an AI can read the same list to spawn typed entities.

import { defaultComponentData, getComponentSchema } from './schema';

export interface EntityPreset {
  /** doubles as the spawned entity's default name. */
  label: string;
  /** component names; built from schema defaults at spawn time. */
  components: string[];
  /** optional per-component field overrides merged onto the schema defaults
   * (e.g. a Sun preset sets Light.type='directional'). Only keys present here
   * deviate from the default — everything else stays schema-driven. */
  overrides?: Record<string, Record<string, unknown>>;
}

export const ENTITY_PRESETS: EntityPreset[] = [
  { label: 'Empty', components: ['Transform'] },
  { label: 'Light', components: ['Transform', 'Light'] },
  { label: 'Sun', components: ['Transform', 'Light'], overrides: { Light: { type: 'directional', intensity: 1.5, color: '#fff8e0' } } },
  { label: 'Spotlight', components: ['Transform', 'Light'], overrides: { Light: { type: 'spot', intensity: 2, spotAngle: 25 } } },
  { label: 'Camera', components: ['Transform', 'Camera'] },
  { label: 'Object', components: ['Transform', 'Material'] },
  { label: 'Ground', components: ['Transform', 'Mesh', 'Material', 'Collider'], overrides: { Transform: { scaleX: 24, scaleY: 0.2, scaleZ: 24 }, Mesh: { kind: 'cube' }, Material: { albedo: '#7a9e5a', roughness: 0.95 }, Collider: { shape: 'box' } } },
  { label: 'Character', components: ['Transform', 'Mesh', 'Material', 'Collider'], overrides: { Transform: { scaleX: 0.7, scaleY: 1.1, scaleZ: 0.7 }, Mesh: { kind: 'cylinder' }, Material: { albedo: '#ff79c6', roughness: 0.5 }, Collider: { shape: 'cylinder', radius: 0.35 } } },
  { label: 'Animated', components: ['Transform', 'Mesh', 'Material', 'Anim'] },
  { label: 'MatGraph', components: ['Transform', 'Mesh', 'MatGraph', 'Material'] },
];

/** Build a preset's components payload from schema defaults. Components without
 * a registered schema are skipped, so a preset never injects an unschematized
 * blob (reflective + safe). */
export function buildPresetComponents(preset: EntityPreset): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const comp of preset.components) {
    if (getComponentSchema(comp)) out[comp] = { ...defaultComponentData(comp), ...(preset.overrides?.[comp] ?? {}) };
  }
  return out;
}

export function getPreset(label: string): EntityPreset | undefined {
  return ENTITY_PRESETS.find((p) => p.label === label);
}

// ── Material presets ──────────────────────────────────────────────────────────
// Ready-to-use PBR looks (metallic-roughness). Applied as a setComponent patch on
// the Material component → only the base PBR scalars/color change; texture slots
// are left untouched. Same data both the human Material panel and an AI can use.
export interface MaterialPreset {
  label: string;
  albedo: string;
  metallic: number;
  roughness: number;
}

export const MATERIAL_PRESETS: MaterialPreset[] = [
  { label: 'Plastic', albedo: '#cccccc', metallic: 0, roughness: 0.5 },
  { label: 'Rubber', albedo: '#1a1a1a', metallic: 0, roughness: 0.95 },
  { label: 'Gold', albedo: '#ffd700', metallic: 1, roughness: 0.25 },
  { label: 'Copper', albedo: '#b87333', metallic: 1, roughness: 0.35 },
  { label: 'Chrome', albedo: '#fafafa', metallic: 1, roughness: 0.05 },
  { label: 'Glass', albedo: '#cfe8ff', metallic: 0, roughness: 0.05 },
];

export function getMaterialPreset(label: string): MaterialPreset | undefined {
  return MATERIAL_PRESETS.find((p) => p.label === label);
}

/** The setComponent patch for a material preset (base PBR only — textures kept). */
export function materialPresetPatch(preset: MaterialPreset): Record<string, unknown> {
  return { albedo: preset.albedo, metallic: preset.metallic, roughness: preset.roughness };
}
