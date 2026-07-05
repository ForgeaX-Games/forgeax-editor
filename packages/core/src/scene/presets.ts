// Entity creation presets — the UE/Unity "Create > Light/Camera/…" surface.
// feat-20260701-editor-world-container-doc-ecs-collapse M2 / AC-18:
// Rewritten from editor-native component names ('Mesh','Material','Light')
// to engine-native component names ('MeshFilter','MeshRenderer','PointLight'
// etc.). Animated/MatGraph presets deleted (engine has no equivalent).
// Single 'Light'+type-enum replaced by three independent presets (scheme A).
//
// spawnComponentData in document.ts auto-adds MeshRenderer with default PBR
// material when MeshFilter is present (AC-06). Presets declare MeshFilter
// geometry; the companion MeshRenderer+materials is handled at spawn time.
//
// Anchors:
//   requirements AC-18: preset = engine component composition
//   requirements AC-17: 3 independent light presets (scheme A)
//   plan-strategy S2 D-3: Light scheme A
//   research F-EngineComponents: MeshFilter/MeshRenderer/PointLight etc.

import { HANDLE_CUBE, HANDLE_CYLINDER } from '@forgeax/engine-runtime';

export interface EntityPreset {
  /** doubles as the spawned entity's default name. */
  label: string;
  /** engine-native component data: component name -> field payload.
   *  Names are engine defineComponent names (MeshFilter, MeshRenderer,
   *  PointLight, SpotLight, DirectionalLight, Collider, Camera, etc.).
   *  Resolved at spawn time via resolveToken (document.ts). */
  components: Record<string, Record<string, unknown>>;
}

export const ENTITY_PRESETS: EntityPreset[] = [
  { label: 'Empty', components: { Transform: {} } },
  {
    label: 'Point Light',
    components: {
      Transform: {},
      PointLight: {},
    },
  },
  {
    label: 'Spot Light',
    components: {
      Transform: {},
      SpotLight: {
        directionX: 0, directionY: -1, directionZ: 0,
      },
    },
  },
  {
    label: 'Directional Light',
    components: {
      Transform: {},
      DirectionalLight: {
        directionX: 0, directionY: -1, directionZ: 0.5,
      },
    },
  },
  { label: 'Camera', components: { Transform: {}, Camera: {} } },
  {
    label: 'Object',
    components: {
      Transform: {},
      MeshFilter: { assetHandle: HANDLE_CUBE },
    },
  },
  {
    label: 'Ground',
    components: {
      Transform: { posY: 0, scaleX: 24, scaleY: 0.2, scaleZ: 24 },
      MeshFilter: { assetHandle: HANDLE_CUBE },
      Collider: { shape: 0, halfExtentsX: 12, halfExtentsY: 0.1, halfExtentsZ: 12 },
    },
  },
  {
    label: 'Character',
    components: {
      Transform: { posY: 0.55, scaleX: 0.7, scaleY: 1.1, scaleZ: 0.7 },
      MeshFilter: { assetHandle: HANDLE_CYLINDER },
      Collider: { shape: 2, radius: 0.35, halfHeight: 0.55 },
    },
  },
];

/** Build a preset's components payload for spawnEntity consumption.
 *  Returns a Record<string, unknown> with engine-native component names
 *  as keys — resolved at spawn time via resolveToken (document.ts). */
export function buildPresetComponents(preset: EntityPreset): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [compName, data] of Object.entries(preset.components)) {
    out[compName] = { ...data };
  }
  return out;
}

export function getPreset(label: string): EntityPreset | undefined {
  return ENTITY_PRESETS.find((p) => p.label === label);
}

// ── Material presets ──────────────────────────────────────────────────────────
// Ready-to-use PBR looks (metallic-roughness). Applied as a setComponent patch
// on the MeshRenderer.materials MaterialAsset. Same data both the human Material
// panel and an AI can use.
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