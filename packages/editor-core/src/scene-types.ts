// EditSession — the editor's authoring working state. The editor (✎ Edit) authors
// a scene through its command bus into an EditSession, which holds the engine's
// pure `SceneAsset` POD projection (`asset`) PLUS the editor-local ID management
// (`nextLocalId` self-increment allocator + `order` spawn-order list) that the
// engine SceneAsset POD intentionally does NOT carry — keeping the engine POD
// free of any "edit"-only field (A0 red line; plan-strategy D-6).
//
// games (▶ Play) fetch the SAME on-disk pack and instantiate it through the
// engine-native scene pipeline. Engine-agnostic authoring data only (no engine
// handles leak into the authoring entity map) so the on-disk pack is
// git-trackable, AI-readable, and portable.

import type { SceneAsset } from '@forgeax/engine-types';

export type EntityId = number;

/** Provenance: which Workbench source produced this instance (enables edit-source
 *  round-trip back to the originating plugin). */
export interface EntitySource {
  plugin: string;
  docId: string;
}

export interface EntityNode {
  id: EntityId;
  name: string;
  parent: EntityId | null;
  components: Record<string, unknown>;
  source?: EntitySource;
  /** editor-only: hidden entities are not drawn in the viewport (authoring aid). */
  hidden?: boolean;
}

/**
 * The editor's authoring working state.
 *
 * `asset` is the engine `SceneAsset` POD projection of the authored entities
 * (rebuilt from `entities`/`order` on every mutation, so it is always fresh) —
 * it carries NO editor-only field. `nextLocalId` + `order` + the rich
 * `entities` authoring map (names / parent links / hidden flags that the engine
 * SceneEntity POD does not model) live here, in the editor, never in the engine
 * POD (A0 red line; plan-strategy D-6).
 */
export interface EditSession {
  /** Engine POD projection of the authored entities (always derived; never the
   *  source of truth — `entities`/`order` are). Pure `{ kind:'scene', entities }`
   *  with NO `nextId`/`order`/`version` field (A0). */
  readonly asset: SceneAsset;
  /** editor-local self-increment id allocator. */
  nextLocalId: EntityId;
  /** authoring entity map — names/parent/hidden the engine POD does not model. */
  entities: Record<EntityId, EntityNode>;
  /** spawn order; per-parent child order derived from `parent`. */
  order: EntityId[];
}

// ── Component value shapes (the fields instantiateScene reads) ────────────────
// All optional/defaulted so partial docs (hand-authored / older) still load.

export interface TransformData {
  x?: number; y?: number; z?: number;
  scaleX?: number; scaleY?: number; scaleZ?: number;
  /** euler degrees (optional; arena geometry is axis-aligned so usually absent). */
  rotX?: number; rotY?: number; rotZ?: number;
}

export type MeshKind = 'cube' | 'sphere' | 'cylinder';
export interface MeshData {
  kind?: MeshKind;
  /** Reference to a mesh ASSET by GUID (e.g. an imported glTF mesh sub-asset).
   *  When set AND the caller supplies a resolver that loads it, this WINS over
   *  `kind` — so an entity can render an imported mesh instead of a builtin
   *  primitive. Empty → fall back to the `kind` builtin (cube/sphere/cylinder). */
  meshAsset?: string;
}

export interface MaterialData {
  /** Reference to a material ASSET by GUID (from a .pack). When set AND the
   *  caller supplies a resolver that loads it, this WINS over the inline fields
   *  below — so a material can live in the asset system + be shared, instead of
   *  being inlined per entity. Empty → use the inline PBR fields. */
  materialAsset?: string;
  /** Per-submesh material asset GUIDs, ordered to match `MeshAsset.submeshes`.
   *  Set when an imported multi-submesh mesh is dropped and its ORIGINAL glTF
   *  materials were recovered (see `resolveMeshOriginalMaterials`). When present
   *  AND the mesh resolves, `instantiate.materialSlots` builds
   *  `MeshRenderer.materials` by resolving each GUID positionally — restoring the
   *  source materials instead of broadcasting a single placeholder. An empty
   *  string at index i means "that submesh had no glTF material" → default.
   *  Empty/absent → existing single-material behaviour. */
  submeshMaterials?: string[];
  albedo?: string;            // #rrggbb base color (LDR)
  metallic?: number;          // 0..1
  roughness?: number;         // 0..1
  emissive?: string;          // #rrggbb (normalized hue; HDR magnitude in emissiveIntensity)
  emissiveIntensity?: number; // multiplier (carries >1 HDR magnitude)
  shading?: 'standard' | 'unlit';
  /** Texture asset GUID slots (resolved at edit-runtime via loadByGuid). */
  albedoMap?: string;
  normalMap?: string;
  ormMap?: string;
}

export type LightType = 'point' | 'spot' | 'directional';
export interface LightData {
  type?: LightType;
  color?: string;             // #rrggbb (normalized hue; magnitude in intensity)
  intensity?: number;
  range?: number;             // point/spot falloff (0 = infinite)
  directionX?: number; directionY?: number; directionZ?: number; // directional only
  spotAngle?: number;
  castShadow?: boolean;
}

export type ColliderShape = 'none' | 'box' | 'cylinder';
export interface ColliderData {
  shape?: ColliderShape;
  /** cylinder radius; box half-extents derive from Transform scale. */
  radius?: number;
}

/** A collision primitive projected from an entity's Collider + Transform, in the
 *  XZ plane. Games map these to their own movement-collision structures. */
export type Collider =
  | { shape: 'box'; x: number; z: number; hw: number; hd: number }
  | { shape: 'cylinder'; x: number; z: number; r: number };
