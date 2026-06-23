// @forgeax/engine-runtime - AssetRegistry v2 (feat-20260513-guid-asset-package-system).
//
// Entrypoints (signatures collapsed to the unified Handle SSOT in
// feat-20260517-handle-type-unify; T is an Asset POD union member, the
// returned tag is `TagOf<T>` which maps T['kind'] to the PascalCase
// literal — e.g. `register<MaterialAsset>(...)` returns
// `Handle<'MaterialAsset', 'unmanaged'>`):
//
//   - registerWithGuid<T extends Asset>(guid, asset): Handle<TagOf<T>, 'unmanaged'>
//   - resolveGuid<T extends Asset>(guid): Result<Handle<TagOf<T>, 'unmanaged'>, AssetError>
//   - guidOf(handle): AssetGuid | undefined
//   - configurePackIndex(url): void
//   - loadByGuid<T extends Asset>(guid): Promise<Result<Handle<TagOf<T>, 'unmanaged'>, AssetError | ImageError | RhiError>>
//       dev/fallback: synchronous Map lookup wrapped in Promise
//       prod: fetch(packIndexUrl) -> parse catalog -> fetch entry -> parse Asset
//   - register<T extends Asset>(asset): Handle<TagOf<T>, 'unmanaged'>          (anonymous; no GUID)
//   - get<T extends Asset>(handle): Result<T, AssetError>                       (miss => asset-not-found)
//   - inspect(): { handles: Array<{ id, brand, refcount: 'immortal' }> }
//
// v1 load(url) removed in feat-20260513-guid-asset-package-system (w12).
// loadByGuid is the replacement; M4/w23 adds real fetch-from-pack-index.
//
// feat-20260514-ecs-children-instances-managed-buffer-array M3 / w15: the
// `createInstancedBuffer` / `updateInstancedBuffer` / `getInstancedGpuBuffer`
// triplet is removed alongside the `InstancedBufferAsset` POD; per-entity
// instance transforms are now stored inside the ECS via the `Instances {
// transforms: 'array<f32>' }` component (the RenderSystem record stage owns
// the GPU storage buffer + dirty-version upload). Asset closed-union narrows
// 5 -> 4; the registry surface loses the optional `RhiDevice` constructor
// argument (no remaining device consumer).
//
// Dual-backend audited: the registry is engine-agnostic (no @webgpu/types
// imports + no rhi-webgpu / rhi-wgpu references); the same instance drives
// both dual-impl shim backends through the @forgeax/engine-rhi interface
// SSOT at the consumer site.

import type { EcsError, EntityHandle, World } from '@forgeax/engine-ecs';
import type { PackError } from '@forgeax/engine-pack/errors';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { err, ok, type Result, type RhiError } from '@forgeax/engine-rhi';
import type { ShaderRegistry } from '@forgeax/engine-shader';
import {
  type AnimationChannel,
  ASSET_ERROR_HINTS,
  type Asset,
  AssetError,
  type AssetErrorCode,
  type AssetErrorDetail,
  type CubeTextureAsset,
  type CubeTextureMetadata,
  derive,
  type FontAsset,
  type Handle,
  IMAGE_ERROR_HINTS,
  type ImageError,
  type ImageErrorDetail,
  type ImageMetadata,
  type ImportTransport,
  type LoadContext,
  type Loader,
  type LoaderAsyncResult,
  type LocalEntityId,
  type MaterialAsset,
  type MaterialPassDescriptor,
  type ParamSchemaEntry,
  type ParseErrorDetail,
  type SceneAsset,
  type SceneEntity,
  type SceneInstanceMount,
  type TagOf,
  type TextureAsset,
  type TextureFormat,
  type MeshAsset as TypesMeshAsset,
  toManaged,
  toUnmanaged,
  unwrapHandle,
} from '@forgeax/engine-types';
import { createBoxGeometry, meshFromInterleaved } from './geometry/box';
import type { LoaderRegistry } from './loader-registry';
import { postSpawnResolveJoints } from './scene-instances/post-spawn-resolve-joints';

/**
 * Strip readonly from all fields of T. Used to mutate the MeshAsset.aabb slot
 * after mesh validation passes (the interface is readonly but register-time
 * computation writes the real AABB into the caller's placeholder).
 */

/** Convert a 16-byte AssetGuid (Uint8Array) to 36-char RFC 4122 dash-form string. */
function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

import { collectRefs } from './collect-refs';
import type { EngineMetrics } from './engine-metrics';
import { MaterialResolvedEmptyPassesError } from './errors';
import { createPlaneGeometry } from './geometry/plane';
import { createSphereGeometry } from './geometry/sphere';
import { unpackMeshBin } from './mesh-bin';
// feat-20260601-gpu-resource-store-extraction M1: the GPU texture / cubemap /
// mesh upload paths moved to GpuResourceStore; the registry retains only
// `numMipLevels` for the POD `mipLevelCount` mirror at load time (CPU
// metadata, no GPU resource).
import { numMipLevels } from './mipmap-generator';
import { extractSceneEntityHandleGuids } from './scene-handle-fields';

// Local minimal `ImageError` constructor (charter P5 producer / consumer
// split: the runtime AssetRegistry should not import @forgeax/engine-image
// errors module because the image package is the disk-side decoder; the
// runtime is the GPU consumer. Both packages share the `ImageError`
// interface SSOT in @forgeax/engine-types so runtime constructs the
// 4-field surface (.code / .expected / .hint / .detail) directly without
// duplicating the @forgeax/engine-image errors.ts class).
const IMAGE_ERROR_EXPECTED_LOCAL: Readonly<Record<string, string>> = {
  'image-decode-failed': 'PNG / JPG byte stream decodes successfully',
  'image-format-unsupported':
    "mime is one of ['image/png', 'image/jpeg']; texture format <-> colorSpace family agrees",
  'image-dimension-out-of-bounds':
    'width and height fall under device caps maxTextureDimension2D (or 16384 hard cap)',
  'image-meta-missing':
    "<source>.meta.json sidecar (assetType: 'image') exists in the same directory",
};

class RuntimeImageError extends Error implements ImageError {
  readonly code: ImageError['code'];
  readonly expected: string;
  readonly hint: string;
  readonly detail: ImageErrorDetail;
  constructor(detail: ImageErrorDetail) {
    const code = detail.code;
    const expected = IMAGE_ERROR_EXPECTED_LOCAL[code] ?? '';
    const hint = IMAGE_ERROR_HINTS[code];
    super(`[ImageError ${code}] expected: ${expected}; hint: ${hint}`);
    this.name = 'ImageError';
    this.code = code;
    this.expected = expected;
    this.hint = hint;
    this.detail = detail;
  }
}

function makeImageError(detail: ImageErrorDetail): ImageError {
  return new RuntimeImageError(detail);
}

// ─── Re-exports for engine-runtime-local consumers ──────────────────────────
//
// Legacy re-exports: `Asset` widens to the 4-variant engine-types union;
// `MeshAsset` keeps the engine-types shape (with `attributes`). Consumers
// that previously imported from `./asset-registry` keep working through
// the type alias re-exports below.

export type { Asset, TypesMeshAsset as MeshAsset };

// ─── Builtin handles (D-S9 / backward compat with hello-triangle + hello-cube) ─

/**
 * Builtin unit-cube mesh handle (8 vertices + 36 indices, pos+normal
 * interleaved). Pair with `MeshFilter` to spawn a cube entity.
 *
 * @remarks Typed as `Handle<'MeshAsset', 'unmanaged'>` — feat-20260517
 * unifies the engine-types and engine-ecs Handle brand SSOT into a single
 * `Handle<T extends string, M extends 'managed'|'unmanaged'>` declaration
 * (research Finding 4 import-path-decoupled identity), and constructs the
 * value via the brand-creation factory `toUnmanaged<'MeshAsset'>(N)` so
 * the caller-side `as unknown as` cast is eliminated (AC-05). The
 * `'unmanaged'` mode signals the AssetRegistry owns the lifecycle — the
 * ECS does not release the slot on despawn / removeComponent / set.
 * Runtime value is a small u32 (1).
 */
export const HANDLE_CUBE: Handle<'MeshAsset', 'unmanaged'> = toUnmanaged<'MeshAsset'>(1);

/**
 * Builtin triangle mesh handle (3 vertices). Pair with `MeshFilter`.
 *
 * @remarks Typed as `Handle<'MeshAsset', 'unmanaged'>` (same narrow brand
 * as HANDLE_CUBE; constructed via the `toUnmanaged<'MeshAsset'>(N)`
 * factory per AC-05).
 */
export const HANDLE_TRIANGLE: Handle<'MeshAsset', 'unmanaged'> = toUnmanaged<'MeshAsset'>(2);

/**
 * Builtin unit-quad mesh handle — 4 vertices, 6 indices, 2 triangles on
 * the XY plane facing +Z. Pair with `MeshFilter` to spawn a sprite quad
 * (feat-20260520-2d-sprite-layer-mvp / M-1 / w06).
 *
 * @derives Same-shape sibling of {@link HANDLE_CUBE} / {@link HANDLE_TRIANGLE}
 *   per requirements §2.1.C: built via the `toUnmanaged<'MeshAsset'>(N)`
 *   brand-creation factory; reserved-id 3 fills the namespace hole between
 *   HANDLE_TRIANGLE=2 and FIRST_USER_HANDLE=1024 (no `BUILTIN_HANDLE_`
 *   prefix per Q2 naming decision — discoverable next to existing
 *   builtins in IDE autocomplete; charter F1 single-entry indexability).
 *
 * @reuses {@link createPlaneGeometry}(1, 1) — the procedural plane factory
 *   already produces 8-floats-per-vertex interleaved (position + normal +
 *   uv) and is then expanded to the runtime 12-floats layout (adds
 *   tangent vec4) by {@link meshFromInterleaved}. This funnels HANDLE_QUAD
 *   onto the exact same vertex pipeline branch as BUILTIN_CUBE /
 *   BUILTIN_TRIANGLE and the procedural geometry factories — zero new
 *   layout discriminator (plan-strategy §3 RT4 + D-9 + charter P4
 *   consistent abstraction).
 *
 * @reuses {@link BUILTIN_FLOATS_PER_VERTEX} = 12 (the single layout SSOT;
 *   the procedural `createPlaneGeometry` factory already returns 12F via
 *   {@link meshFromInterleaved}). Reviewer can grep `BUILTIN_FLOATS_PER_VERTEX`
 *   to enumerate every consumer of this constant.
 */
export const HANDLE_QUAD: Handle<'MeshAsset', 'unmanaged'> = toUnmanaged<'MeshAsset'>(3);

/**
 * Id=4 reserved builtin; occupies the next available slot under
 * FIRST_USER_HANDLE=1024. BUILTIN_SPHERE is synthesised from
 * `createSphereGeometry(1, 16, 12)` through the same
 * `meshFromInterleaved` path as BUILTIN_QUAD, so the runtime
 * 12-float stride is byte-identical to procedural output — zero
 * new layout discriminator (charter P4 consistent abstraction).
 */
export const HANDLE_SPHERE: Handle<'MeshAsset', 'unmanaged'> = toUnmanaged<'MeshAsset'>(4);

/**
 * Builtin 9-slice quad mesh handle — 4×4 grid (16 vertices, 9 sub-quads,
 * 54 indices) on the XY plane facing +Z. Pair with `MeshFilter` and a
 * `MaterialAsset` whose first pass shader is `'forgeax::sprite'` and whose
 * `paramValues.slices` is non-zero to render a 9-sliced UI panel
 * (feat-20260527-sprite-nineslice / M2 / w9).
 *
 * @derives Same-shape sibling of {@link HANDLE_QUAD}: synthesised from
 *   `createPlaneGeometry(1, 1, 3, 3)` which subdivides the unit quad into
 *   3×3 sub-quads (9 cells). The 16 grid points and 54 indices feed
 *   {@link meshFromInterleaved} so the runtime 12-float vertex stride is
 *   byte-identical to all other built-in / procedural meshes — zero new
 *   layout discriminator (charter P4 consistent abstraction).
 *
 * @remarks Id=5 follows {@link HANDLE_SPHERE}=4 in the builtin slot
 *   sequence (FIRST_USER_HANDLE=1024 untouched). The vertex shader uses
 *   `vertex_index % 4` / `vertex_index / 4` to recover (i, j) grid
 *   coordinates and four anchor vec4s to map each grid cell to the right
 *   region of the source texture; only required when the sprite material
 *   declares non-zero `slices`. For the legacy zero-slice sprite path use
 *   {@link HANDLE_QUAD}.
 *
 * @reuses {@link BUILTIN_FLOATS_PER_VERTEX} = 12 (sprite-pipeline binding
 *   table / vertex layout untouched). plan-strategy §D-2 NOTE clarifies
 *   the id=5 vs original-plan id=4 drift: HANDLE_SPHERE took id=4 in
 *   feat-20260529-fxaa-sphere-builtin before this feat landed.
 */
export const HANDLE_NINESLICE_QUAD: Handle<'MeshAsset', 'unmanaged'> = toUnmanaged<'MeshAsset'>(5);

/**
 * Stable GUIDs for the builtin meshes — the dash-form of
 * `deriveBuiltin('HANDLE_<NAME>')` (UUIDv5, ForgeaX namespace) in
 * `@forgeax/engine-pack`. They are inlined here (not imported) because the
 * pack derivation runs under top-level `await` (async SubtleCrypto) and
 * dragging that into the AssetRegistry constructor — a synchronous hot path
 * consumed engine-wide — would make the whole runtime module graph async.
 *
 * The single source of truth remains `deriveBuiltin`: a cross-package
 * guard test (`builtin-guid-ssot.test.ts`) asserts each literal equals the
 * derived value, so any drift in the derivation reds the suite. This pairs
 * the previously-disconnected dual truths (the u32 `HANDLE_*` constants and
 * the pack GUID strings) into one bidirectionally-resolvable table, so
 * `guidOf(HANDLE_CUBE)` no longer returns `undefined`
 * (docs/feedbacks/2026-06-03 §6.2 Tier 0).
 */
const BUILTIN_MESH_GUIDS: ReadonlyArray<readonly [Handle<'MeshAsset', 'unmanaged'>, string]> = [
  [HANDLE_CUBE, 'cbe42beb-8975-5096-b3a1-3dda4cb4c077'],
  [HANDLE_TRIANGLE, '22592f07-d967-5116-b29c-fa9781929ba8'],
  [HANDLE_QUAD, '339338aa-a338-581c-9fc5-744267ef8a51'],
  [HANDLE_SPHERE, '95730fd2-9846-5f84-8658-0b3c971eb263'],
  [HANDLE_NINESLICE_QUAD, '692d38b4-8cac-5fb2-9dcf-f389e076d6bf'],
];

const FIRST_USER_HANDLE = 1024;

/**
 * Floats per vertex for BUILTIN_CUBE / BUILTIN_TRIANGLE inline geometry:
 * position(3) + normal(3) + uv(2) + tangent(4) = 12. The BUILTIN constants
 * are now 12-floats (bug-20260519): the prior 6-floats stride forced UVs
 * to (0,0) via a zero-stride dummy attribute buffer, so a textured BUILTIN
 * cube sampled a single texel and looked flat-coloured. With 12-floats both
 * BUILTIN and procedural meshes funnel through one vertex pipeline branch
 * (`unlitPipeline` / `standardPipeline`).
 */
export const BUILTIN_FLOATS_PER_VERTEX = 12;

// ─── Builtin geometry data (12F: position + normal + uv + tangent) ──────────
// BUILTIN_CUBE is synthesized from `createBoxGeometry(1, 1, 1)` so the cube
// inherits Three.js-aligned per-face UV unwrap and per-vertex tangent vec4.
// The procedural factory always returns Result.ok for valid (>0) extents,
// hence the unwrap-with-throw is safe at module init.
const builtinCubeRes = createBoxGeometry(1, 1, 1);
if (!builtinCubeRes.ok) {
  throw new Error(`[asset-registry] createBoxGeometry(1,1,1) failed: ${builtinCubeRes.error.code}`);
}
const BUILTIN_CUBE: TypesMeshAsset = Object.freeze(builtinCubeRes.value);

// BUILTIN_TRIANGLE: 3 vertices in the XY plane facing +Z, with a [0..1]² UV
// triangle so a textured triangle samples the texture (apex = top-centre,
// base = bottom-left / bottom-right). meshFromInterleaved expands the
// 8-floats interleaved input (pos + normal + uv) to the runtime 12-floats
// stride (adds tangent vec4 per `geometry/tangent.ts` path A).
const BUILTIN_TRIANGLE: TypesMeshAsset = Object.freeze(
  meshFromInterleaved(
    new Float32Array([
      // pos.xyz                normal.xyz       uv.xy
      0, 0.7, 0, 0, 0, 1, 0.5, 1, -0.7, -0.6, 0, 0, 0, 1, 0, 0, 0.7, -0.6, 0, 0, 0, 1, 1, 0,
    ]),
    new Uint16Array([0, 1, 2]),
  ),
);

// BUILTIN_QUAD: unit-size plane on XY facing +Z (4 vertices, 2 triangles,
// 6 indices). Synthesised from `createPlaneGeometry(1, 1)` (which itself
// chains through `meshFromInterleaved`) so the resulting MeshAsset is
// byte-identical to procedural plane output — zero new layout
// discriminator, AI users reason about UV / pivot semantics by reading
// `packages/runtime/src/geometry/plane.ts` (charter P4 consistent
// abstraction; feat-20260520 M-1 / w06).
const builtinQuadRes = createPlaneGeometry(1, 1);
if (!builtinQuadRes.ok) {
  throw new Error(`[asset-registry] createPlaneGeometry(1,1) failed: ${builtinQuadRes.error.code}`);
}
const BUILTIN_QUAD: TypesMeshAsset = Object.freeze(builtinQuadRes.value);

// BUILTIN_SPHERE: UV-sphere synthesised from createSphereGeometry(1, 16, 12).
// Vertices are at exact radius-1 positions (sphere.ts:40-45) so the
// |hypot(pos)-1| < 1e-6 radius invariant holds by construction. Index
// buffer is Uint32Array — downstream consumers (step-3 upload loop,
// createRenderer.ts:2319) auto-select 'uint32' indexFormat via
// `instanceof Uint32Array`.
const builtinSphereRes = createSphereGeometry(1, 16, 12);
if (!builtinSphereRes.ok) {
  throw new Error(
    `[asset-registry] createSphereGeometry(1,16,12) failed: ${builtinSphereRes.error.code}`,
  );
}
const BUILTIN_SPHERE: TypesMeshAsset = Object.freeze(builtinSphereRes.value);

// BUILTIN_NINESLICE_QUAD: 4×4 grid plane synthesised from
// createPlaneGeometry(1, 1, 3, 3) — 16 vertices, 9 sub-quads × 6 indices = 54.
// Reuses the unit-quad vertex layout (12F: pos + normal + uv + tangent) so
// HANDLE_NINESLICE_QUAD funnels through the same sprite-pipeline binding
// table as HANDLE_QUAD; only the vertex_index → (i, j) decomposition in
// sprite.wgsl branches on slices presence (feat-20260527-sprite-nineslice
// M3, plan-strategy §D-2 + §D-4).
const builtinNineSliceQuadRes = createPlaneGeometry(1, 1, 3, 3);
if (!builtinNineSliceQuadRes.ok) {
  throw new Error(
    `[asset-registry] createPlaneGeometry(1,1,3,3) failed: ${builtinNineSliceQuadRes.error.code}`,
  );
}
const BUILTIN_NINESLICE_QUAD: TypesMeshAsset = Object.freeze(builtinNineSliceQuadRes.value);

// ─── Runtime brand helper ──────────────────────────────────────────────────
//
// AC-11 inspect() `.brand` is a 4-member string literal union mirroring the
// engine-types Asset discriminated union. Map a stored Asset value to its
// brand via the `.kind` discriminator (+ `.shadingModel` refinement for
// `MaterialAsset`, preserved for forward compatibility though the runtime
// brand stays at the asset-kind level per AC-11 spec).
//
// feat-20260514 M3 / w15: the `'InstancedBufferAsset'` brand is retired
// alongside the deleted POD + 3 registry methods; the runtime brand union
// shrinks 5 -> 4 to mirror the Asset closed-union shape.
// feat-20260514 w3: re-extends to 5 with the addition of the `'SceneAsset'`
// brand mirroring the new `'scene'` kind in the Asset discriminated union.

type AssetBrand =
  | 'MeshAsset'
  | 'TextureAsset'
  | 'CubeTextureAsset'
  | 'SamplerAsset'
  | 'MaterialAsset'
  | 'SceneAsset'
  | 'SkeletonAsset'
  | 'SkinAsset'
  | 'AnimationClip'
  | 'AudioClipAsset'
  | 'ShaderAsset'
  | 'FontAsset'
  | 'RenderPipelineAsset';

function assetBrand(asset: Asset): AssetBrand {
  switch (asset.kind) {
    case 'mesh':
      return 'MeshAsset';
    case 'texture':
      return 'TextureAsset';
    case 'sampler':
      return 'SamplerAsset';
    case 'material':
      return 'MaterialAsset';
    case 'scene':
      return 'SceneAsset';
    case 'cube-texture':
      return 'CubeTextureAsset';
    case 'skeleton':
      return 'SkeletonAsset';
    case 'skin':
      return 'SkinAsset';
    case 'animation-clip':
      return 'AnimationClip';
    case 'audio':
      return 'AudioClipAsset';
    case 'shader':
      return 'ShaderAsset';
    case 'font':
      return 'FontAsset';
    case 'render-pipeline':
      return 'RenderPipelineAsset';
  }
}

// ─── Schema-driven material parse result (feat-20260523 M4-T01) ──────────
// ─── AssetRegistry class ────────────────────────────────────────────────────

// Reconstruct a CubeTextureAsset POD from a serialised pack payload
// (feat-20260520-skylight-ibl-cubemap M1). The payload arrives as a pack
// file asset entry; this helper validates the structural fields and
// reconstructs the CubeTextureAsset POD shape.
function parseCubeTexturePayload(payload: Record<string, unknown>): CubeTextureAsset | undefined {
  const rawFaces = payload.faces;
  if (!Array.isArray(rawFaces) || rawFaces.length !== 6) return undefined;
  for (const f of rawFaces) {
    if (!(f instanceof Uint8Array)) return undefined;
  }
  const width = payload.width;
  const height = payload.height;
  if (typeof width !== 'number' || typeof height !== 'number') return undefined;
  if (typeof payload.format !== 'string') return undefined;
  return {
    kind: 'cube-texture',
    width: width as number,
    height: height as number,
    format: payload.format as TextureFormat,
    faces: rawFaces as readonly Uint8Array[],
  };
}

/**
 * Field names known to carry handle<> schema-vocab references (plan-strategy
 * D-4).  parseScenePayload uses this allowlist to replace integer values
 * with GUID strings from refs[] only for handle fields — Transform.posX=0,
 * ChildOf.parent=0 and similar non-handle integers are left untouched.
 *
 * When a new handle<> field is added to a runtime component, its field name
 * MUST be added here so parseScenePayload correctly resolves it.
 */
const HANDLE_FIELD_NAMES: ReadonlySet<string> = new Set([
  'assetHandle',
  'material',
  'skeleton',
  'clip',
  'cubemap',
]);

/**
 * Field names known to carry `array<handle<X>>` schema-vocab references
 * (feat-20260608 M2 / w7: MeshRenderer.materials). Each element is a refs
 * index that resolves to a GUID string. Coexists with HANDLE_FIELD_NAMES;
 * a field name lives in exactly one set.
 */
const HANDLE_ARRAY_FIELD_NAMES: ReadonlySet<string> = new Set(['materials']);

/**
 * Structured error returned by parseScenePayload when a refs index is
 * out of bounds (F-2 / AC-02).
 */
interface ParseSceneError {
  readonly localId: number;
  readonly component: string;
  readonly field: string;
  readonly index: number;
  readonly refsLength: number;
}

// Reconstruct a SceneAsset POD from a serialised pack payload (feat-20260514
// w3 / parseAssetPayload 'scene' dispatch). The payload arrives as the
// outer pack file's `assets[i].payload` object after ajv structural
// validation; this helper re-stamps the LocalEntityId brand on each
// SceneEntity.localId field and freezes the resulting POD shape so consumer
// code sees the same readonly surface as a hand-authored SceneAsset (AC-01
// + plan-strategy §3.1 rt_pkg sub-graph).
//
// feat-20260528-scene-asset-guid-refs-and-post-instantiate M1-fixup F-1:
// refs parameter — when provided, integer values in handle-type component
// fields (identified via HANDLE_FIELD_NAMES allowlist, plan-strategy D-4)
// are replaced with refs[N] (GUID string). Non-handle integer fields
// (Transform posX/posY/posZ/quatW/scalex/y/z, ChildOf.parent Entity, etc.)
// are kept as-is.
//
// feat-20260528-scene-asset-guid-refs-and-post-instantiate M1-fixup F-2:
// out-of-bounds (N < 0 or N >= refs.length) returns a structured
// ParseSceneError with localId + component + field + index + refs.length
// so the caller can construct a precise AssetError (AC-02).
// The M1 stop-on-first-error (AC-08) behaviour is preserved.
function parseScenePayload(
  payload: Record<string, unknown>,
  refs?: string[],
): SceneAsset | ParseSceneError | undefined {
  const rawEntities = payload.entities;
  if (!Array.isArray(rawEntities)) return undefined;
  const nodes: SceneEntity[] = [];
  for (const rn of rawEntities as Array<{ localId?: unknown; components?: unknown }>) {
    if (typeof rn.localId !== 'number') return undefined;
    const rawComponents = (rn.components ?? {}) as Record<string, Record<string, unknown>>;

    // Resolve refs indices to GUID strings only for handle-type fields
    // (plan-strategy D-4 / F-1 fix: non-handle integers preserved as-is).
    if (refs) {
      const resolvedComponents: Record<string, Record<string, unknown>> = {};
      for (const compName of Object.keys(rawComponents)) {
        const rawFields = rawComponents[compName];
        if (!rawFields) continue;
        const resolvedFields: Record<string, unknown> = {};
        for (const fieldName of Object.keys(rawFields)) {
          const value = rawFields[fieldName];
          if (
            HANDLE_FIELD_NAMES.has(fieldName) &&
            typeof value === 'number' &&
            Number.isInteger(value)
          ) {
            const idx = value;
            if (idx < 0 || idx >= refs.length) {
              return {
                localId: rn.localId as number,
                component: compName,
                field: fieldName,
                index: idx,
                refsLength: refs.length,
              };
            }
            resolvedFields[fieldName] = refs[idx];
          } else if (HANDLE_ARRAY_FIELD_NAMES.has(fieldName) && Array.isArray(value)) {
            // feat-20260608 M2 / w7: array<handle<X>> field — each element is a
            // refs index resolved to a GUID string. Out-of-bounds in any element
            // surfaces the same ParseSceneError as the scalar handle path.
            const resolvedArr: string[] = [];
            for (let elemIdx = 0; elemIdx < value.length; elemIdx++) {
              const elem = value[elemIdx];
              if (typeof elem !== 'number' || !Number.isInteger(elem)) {
                resolvedFields[fieldName] = value;
                resolvedArr.length = 0;
                break;
              }
              if (elem < 0 || elem >= refs.length) {
                return {
                  localId: rn.localId as number,
                  component: compName,
                  field: `${fieldName}[${elemIdx}]`,
                  index: elem,
                  refsLength: refs.length,
                };
              }
              const ref = refs[elem];
              if (ref !== undefined) resolvedArr.push(ref);
            }
            if (resolvedArr.length === value.length) {
              resolvedFields[fieldName] = resolvedArr;
            } else if (resolvedFields[fieldName] === undefined) {
              resolvedFields[fieldName] = value;
            }
          } else {
            resolvedFields[fieldName] = value;
          }
        }
        resolvedComponents[compName] = resolvedFields as Record<string, unknown>;
      }
      nodes.push({
        localId: rn.localId as LocalEntityId,
        components: resolvedComponents,
      });
    } else {
      nodes.push({
        localId: rn.localId as LocalEntityId,
        components: rawComponents,
      });
    }
  }
  const resolvedMounts = resolveMounts(payload, refs);
  if (resolvedMounts === undefined && Array.isArray(payload.mounts)) {
    // mounts resolution failed (e.g. out-of-bounds source index)
    return undefined;
  }
  // feat-20260612 M2 fixup: resolve `skinGuids` field (refs[] indices on disk
  // -> GUID strings post-parse). The SkinAsset chain has no entity-component
  // hook so the scene must carry an explicit cross-edge list; without it,
  // browser-async-pack-fetch never loads SkinAssets and postSpawnResolveJoints
  // silently skips, leaving Skin.joints.length=0 for every frame.
  const resolvedSkinGuids = resolveSkinGuids(payload, refs);
  if (resolvedSkinGuids === undefined && Array.isArray(payload.skinGuids)) {
    return undefined;
  }
  return {
    kind: 'scene',
    entities: nodes,
    mounts: resolvedMounts as unknown as readonly SceneInstanceMount[],
    ...(resolvedSkinGuids !== undefined ? { skinGuids: resolvedSkinGuids } : {}),
  } as SceneAsset;
}

/**
 * feat-20260612 M2 fixup: resolve `SceneAsset.skinGuids` -- on-disk refs[]
 * indices into post-parse GUID strings. Mirror of {@link resolveMounts}.
 * Returns undefined when no `skinGuids` field is present (back-compat:
 * pre-M2 SceneAssets carry no skin cross-edges).
 */
function resolveSkinGuids(
  payload: Record<string, unknown>,
  refs: readonly string[] | undefined,
): readonly string[] | undefined {
  const raw = payload.skinGuids;
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const item of raw as ReadonlyArray<unknown>) {
    if (typeof item === 'string') {
      // Pre-resolved GUID string (in-memory dawn smoke / direct register path).
      out.push(item);
    } else if (typeof item === 'number' && Number.isInteger(item)) {
      // refs[] index path (browser pack-fetch JSON-roundtrip shape).
      if (refs === undefined) return undefined;
      if (item < 0 || item >= refs.length) return undefined;
      const guid = refs[item];
      if (typeof guid !== 'string') return undefined;
      out.push(guid);
    } else {
      return undefined;
    }
  }
  return out;
}

/**
 * Resolve mounts[].source integer indices through refs[] to GUID strings.
 * Mount.source is resolved positionally (not through HANDLE_FIELD_NAMES),
 * per AC-11. Returns undefined when no mounts field is present (back-compat).
 */
function resolveMounts(
  payload: Record<string, unknown>,
  refs: readonly string[] | undefined,
): ReadonlyArray<Record<string, unknown>> | undefined {
  const rawMounts = payload.mounts;
  if (!Array.isArray(rawMounts)) return undefined;
  if (refs === undefined) return rawMounts as ReadonlyArray<Record<string, unknown>>;
  const resolved: Record<string, unknown>[] = [];
  for (const rm of rawMounts as ReadonlyArray<Record<string, unknown>>) {
    const mount = { ...rm };
    const source = rm.source;
    if (typeof source === 'number' && Number.isInteger(source)) {
      const idx = source;
      if (idx < 0 || idx >= refs.length) {
        return undefined;
      }
      mount.source = refs[idx];
    }
    resolved.push(mount);
  }
  return resolved;
}

// === Inline pack-payload loader bodies (feat-20260603-asset-import-loader-injection
// M1 / w4) ===
//
// The seven `if (kind === ...)` arms that lived inside
// `AssetRegistry.parseAssetPayload` (research Finding 1) are extracted here as
// module-level `{ kind, load }` objects so they register into a
// `LoaderRegistry` (D-1) and can be imported by `wireDefaultLoaders` (w5). The
// body logic is copied verbatim — M1 is a pure refactor (AC-03), no behavioural
// change. Each parses an inline `.pack.json` payload synchronously and returns
// the `Asset` POD or `undefined` (parse rejected). The `scene` arm routes its
// structured out-of-bounds-ref error back through `ctx.reportParseError`
// instead of the old `this.lastParseSceneError` write (D-8 channel preserved).

/** mesh loader — Float32Array / Uint16Array | Uint32Array normalisation -> MeshAsset.
 *
 * feat-20260611: skinIndex (Uint16Array) and skinWeight (Float32Array) accept
 * both their native typed-array shape (in-memory: dawn smoke / direct
 * `register` test) AND `number[]` (post-`JSON.stringify` shape produced by the
 * dev-server / build-mode pack-body round-trip — `JSON.stringify(pack) -> fetch
 * -> JSON.parse` flattens every typed array to a plain Array). Same dual
 * contract `skeletonLoader` / `animationClipLoader` already honour (PR #350);
 * without the array arm, every Fox.glb / Khronos skinned glTF surfaces as
 * `asset-parse-failed` on the browser path while dawn smoke stays green.
 */
export const meshLoader: Loader = {
  kind: 'mesh',
  load(payload) {
    const vertexData = payload.vertices;
    const indexData = payload.indices;
    const rawAttributes = (payload.attributes as Record<string, unknown> | undefined) ?? {};
    const attributes: Record<string, unknown> = { ...rawAttributes };

    const skinIndexRaw = rawAttributes.skinIndex;
    if (skinIndexRaw instanceof Uint16Array) {
      attributes.skinIndex = skinIndexRaw;
    } else if (Array.isArray(skinIndexRaw)) {
      attributes.skinIndex = new Uint16Array(skinIndexRaw as number[]);
    } else if (skinIndexRaw !== undefined) {
      return undefined;
    }

    const skinWeightRaw = rawAttributes.skinWeight;
    if (skinWeightRaw instanceof Float32Array) {
      attributes.skinWeight = skinWeightRaw;
    } else if (Array.isArray(skinWeightRaw)) {
      attributes.skinWeight = new Float32Array(skinWeightRaw as number[]);
    } else if (skinWeightRaw !== undefined) {
      return undefined;
    }

    let vertices: Float32Array;
    let indices: Uint16Array | Uint32Array | undefined;

    if (vertexData instanceof Float32Array) {
      vertices = vertexData;
    } else if (Array.isArray(vertexData)) {
      vertices = new Float32Array(vertexData as number[]);
    } else {
      return undefined;
    }

    // bug-20260610: index width must follow vertex count, not a hard-coded
    // Uint16Array. A glTF mesh (e.g. Sponza, ~192k merged verts) overflows
    // Uint16; round-tripping through Uint16Array silently wraps and
    // `mesh-vertex-stride-mismatch` then fires because `maxIndex + 1` no
    // longer equals `vertexCount`. Mirrors `meshIrToMeshAsset` in
    // packages/gltf/src/bridge.ts which picks Uint32 above 0xffff.
    //
    // feat-20260612 M2 fixup: when the input carries an empty index array
    // (Fox.glb-style non-indexed primitives flattened through the mesh-bin
    // sidecar with `ilen=0`), drop the indices field rather than emit a
    // 0-byte typed array. The downstream `gpu-resource-store` chooses the
    // indexed-vs-vertex-only path on `mesh.indices !== undefined`; a 0-byte
    // typed array still satisfies !== undefined and triggers a 0-size IBO
    // allocation, whose `setIndexBuffer(buffer.slice(0..0), ...)` panics
    // wgpu's `BufferSlice` "buffer slices can not be empty" assertion.
    if (indexData instanceof Uint16Array || indexData instanceof Uint32Array) {
      indices = indexData.length > 0 ? indexData : undefined;
    } else if (Array.isArray(indexData)) {
      const arr = indexData as number[];
      if (arr.length === 0) {
        indices = undefined;
      } else {
        const vertexCount = vertices.length / BUILTIN_FLOATS_PER_VERTEX;
        const useUint32 = vertexCount > 0xffff;
        indices = useUint32 ? new Uint32Array(arr) : new Uint16Array(arr);
      }
    } else if (indexData === undefined) {
      indices = undefined;
    } else {
      return undefined;
    }

    // feat-20260608 M5 / w27: pack-payload mesh assets default to a single
    // triangle-list submesh covering the full index/vertex range. Inline
    // .pack.json mesh payloads do not carry submesh tables (single-prim
    // legacy shape); render code unconditionally reads `submeshes[0]`.
    // vertexCount stored as full vertices.length (downstream computes per-
    // attribute strides; submesh keeps the buffer-element-count for now).
    //
    // bug-20260610: when the payload carries an explicit `submeshes` table
    // (gltf importer emits one per primitive), respect it. The
    // `triangle-list 0..indices.length` default fits only single-prim packs.
    const payloadSubmeshes = payload.submeshes;
    const submeshes =
      Array.isArray(payloadSubmeshes) && payloadSubmeshes.length > 0
        ? (payloadSubmeshes as unknown as TypesMeshAsset['submeshes'])
        : [
            {
              indexOffset: 0,
              indexCount: indices?.length ?? 0,
              vertexCount: vertices.length,
              topology: 'triangle-list' as const,
            },
          ];

    return {
      kind: 'mesh',
      vertices,
      ...(indices !== undefined ? { indices } : {}),
      attributes: attributes as TypesMeshAsset['attributes'],
      aabb: new Float32Array(6),
      submeshes,
    };
  },
};

/** scene loader — delegates to parseScenePayload; routes structured ref error via ctx. */
export const sceneLoader: Loader = {
  kind: 'scene',
  load(payload, refs, ctx: LoadContext) {
    const result = parseScenePayload(payload, refs === undefined ? undefined : [...refs]);
    if (result === undefined) return undefined;
    // Structured ParseSceneError (has an `index` field absent on SceneAsset):
    // route the detail back through the loader context so the caller can
    // contextualise it into a precise AssetError (D-8 channel).
    if ('index' in result) {
      ctx.reportParseError?.(result as ParseErrorDetail);
      return undefined;
    }
    return result as Asset;
  },
};

/** cube-texture loader — delegates to parseCubeTexturePayload. */
export const cubeTextureLoader: Loader = {
  kind: 'cube-texture',
  load(payload) {
    return parseCubeTexturePayload(payload);
  },
};

/**
 * feat-20260613-material-paramschema-driven-binding M4 / w22 (D-5 graceful):
 * the legacy hardcoded texture-field allowlist Set has been removed
 * (AC-03). The materialLoader now consults `ctx.getMaterialShaderTextureFieldNames`
 * (paramSchema-derived via derive()) to know which paramValues fields carry
 * refs[] indices. When the shader is not yet registered (cross-worktree
 * shader-late-register path, plan R-4), the loader falls back to attempting
 * resolution on every int-typed paramValue in [0, refs.length) — M4 / w23's
 * extract-layer paramSchema validation catches misclassifications and routes
 * unresolved texture slots through `MISSING_TEXTURE_HANDLE`.
 */
function collectShaderTextureFieldNames(
  passesFromPayload: unknown,
  ctx: LoadContext,
): ReadonlySet<string> | undefined {
  if (!Array.isArray(passesFromPayload) || passesFromPayload.length === 0) return undefined;
  const lookup = ctx.getMaterialShaderTextureFieldNames;
  if (lookup === undefined) return undefined;
  const collected = new Set<string>();
  let anyResolved = false;
  for (const pass of passesFromPayload) {
    const shaderId = (pass as { shader?: unknown }).shader;
    if (typeof shaderId !== 'string' || shaderId.length === 0) continue;
    const fields = lookup(shaderId);
    if (fields === undefined) continue;
    anyResolved = true;
    for (const name of fields) collected.add(name);
  }
  return anyResolved ? collected : undefined;
}

/** material loader — passes + paramValues + parent ref-index -> parentGuid string. */
export const materialLoader: Loader = {
  kind: 'material',
  load(payload, refs, ctx: LoadContext) {
    const matPayload = payload;
    const passesFromPayload = matPayload.passes;
    const rawParamValues = (matPayload.paramValues as Record<string, unknown>) ?? {};

    let parentGuid: string | undefined;
    if (typeof matPayload.parent === 'number') {
      const idx = matPayload.parent;
      const refsArr = refs ?? [];
      if (idx >= 0 && idx < refsArr.length) {
        const refGuid = refsArr[idx];
        if (typeof refGuid === 'string') {
          parentGuid = refGuid;
        }
      }
      if (parentGuid === undefined) {
        return undefined;
      }
    }

    // bug-20260610: paramValues fields that are typed `handle<TextureAsset>`
    // arrive on disk as a refs[] index (small int 0..refs.length-1). The
    // build-time gltfImporter writes these as refs indices, mirroring the
    // scene's HANDLE_FIELD_NAMES treatment.
    //
    // feat-20260613-material-paramschema-driven-binding M4 / w22 (D-5 graceful):
    // texture-field discovery now derives from the registered shader's
    // paramSchema via `ctx.getMaterialShaderTextureFieldNames`. When the
    // shader is registered (the common case), only declared texture fields
    // are resolved — identical to the old hardcoded-Set behaviour without the
    // SSOT duplication. When the shader is not yet registered (cross-worktree
    // shader-late-register, plan R-4), every int-typed paramValue in
    // [0, refs.length) is attempted; the M4 / w23 extract layer's paramSchema
    // validation catches misclassified scalars and falls back to
    // MISSING_TEXTURE_HANDLE.
    const paramValues: Record<string, unknown> = { ...rawParamValues };
    if (refs && refs.length > 0) {
      const shaderTextureFields = collectShaderTextureFieldNames(passesFromPayload, ctx);
      const candidateFields =
        shaderTextureFields !== undefined ? shaderTextureFields : Object.keys(paramValues);
      for (const fieldName of candidateFields) {
        const value = paramValues[fieldName];
        if (typeof value !== 'number' || !Number.isInteger(value)) continue;
        if (value < 0 || value >= refs.length) {
          // Only emit a parse-error breadcrumb when the field is declared as
          // a texture by the shader paramSchema (the OOB is unambiguous).
          // For the graceful "try every int" fallback, OOB simply means
          // "this scalar was not a refs index" — don't spam parse errors.
          if (shaderTextureFields !== undefined) {
            ctx.reportParseError?.({
              localId: -1,
              component: 'MaterialAsset.paramValues',
              field: fieldName,
              index: value,
              refsLength: refs.length,
            } as ParseErrorDetail);
            delete paramValues[fieldName];
          }
          continue;
        }
        const refGuid = refs[value];
        if (typeof refGuid !== 'string') {
          if (shaderTextureFields !== undefined) {
            delete paramValues[fieldName];
          }
          continue;
        }
        const handleNum = ctx.resolveRefSync?.(refGuid);
        if (typeof handleNum === 'number') {
          paramValues[fieldName] = handleNum;
        } else if (shaderTextureFields !== undefined) {
          // Shader-declared texture field whose sub-asset has not registered
          // yet. The material registration proceeds without this slot — the
          // GPU layer falls back to MISSING_TEXTURE_HANDLE (default white).
          // The build-time pre-import + recursive loadByGuid walk should
          // register the texture before this point; if not, the missing
          // slot surfaces as a flat-coloured submesh, signalling a
          // load-order regression rather than silently sampling handle 1.
          delete paramValues[fieldName];
        }
      }
    }

    if (Array.isArray(passesFromPayload) && passesFromPayload.length > 0) {
      return {
        kind: 'material',
        passes: passesFromPayload as readonly MaterialPassDescriptor[],
        paramValues,
        parentGuid,
      } as MaterialAsset & { parentGuid?: string };
    }

    if (parentGuid !== undefined) {
      return {
        kind: 'material',
        paramValues,
        parentGuid,
      } as unknown as MaterialAsset & { parentGuid?: string };
    }

    return undefined;
  },
};

/** skeleton loader — inverseBindMatrices stride validation.
 *
 * bug-20260611: accept both `Float32Array` (in-memory: dawn smoke / direct
 * `register` test) AND `number[]` (post-`JSON.stringify` shape: `normaliseForPack`
 * in @forgeax/engine-import flattens every typed array to a plain Array so
 * `JSON.stringify(pack)` survives the dev-server / build-mode round-trip --
 * the same dual contract `meshLoader` already honours). Without the array arm
 * the .pack.json -> fetch -> JSON.parse path lands a plain object whose
 * `instanceof Float32Array` check fails, surfacing as `asset-parse-failed`
 * for any glTF carrying a Skin (e.g. Khronos Fox.glb).
 */
export const skeletonLoader: Loader = {
  kind: 'skeleton',
  load(payload) {
    const ibmRaw = payload.inverseBindMatrices;
    const jointCount = typeof payload.jointCount === 'number' ? payload.jointCount : 0;
    let ibm: Float32Array;
    if (ibmRaw instanceof Float32Array) {
      ibm = ibmRaw;
    } else if (Array.isArray(ibmRaw)) {
      ibm = new Float32Array(ibmRaw as number[]);
    } else {
      return undefined;
    }
    if (ibm.byteLength !== jointCount * 64) return undefined;
    return {
      kind: 'skeleton',
      inverseBindMatrices: ibm,
      jointCount,
    };
  },
};

/** skin loader — skeletonGuid + jointPaths validation. */
export const skinLoader: Loader = {
  kind: 'skin',
  load(payload) {
    const skeletonGuid = payload.skeletonGuid;
    const jointPathsRaw = payload.jointPaths;
    if (typeof skeletonGuid !== 'string') return undefined;
    if (!Array.isArray(jointPathsRaw)) return undefined;
    const jointPaths: string[] = [];
    for (const item of jointPathsRaw) {
      if (typeof item !== 'string') return undefined;
      jointPaths.push(item);
    }
    return { kind: 'skin', skeletonGuid, jointPaths };
  },
};

/** animation-clip loader — channels / sampler validation.
 *
 * bug-20260611: sampler.input / sampler.output accept both `Float32Array`
 * (in-memory) and `number[]` (post-`JSON.stringify` shape produced by
 * `normaliseForPack`). Same dual contract as `skeletonLoader` /
 * `meshLoader`; without it the dev `.pack.json` round-trip surfaces every
 * skinned-with-animation glTF as `asset-parse-failed`.
 */
export const animationClipLoader: Loader = {
  kind: 'animation-clip',
  load(payload) {
    const duration = typeof payload.duration === 'number' ? payload.duration : 0;
    const channelsRaw = payload.channels;
    if (!Array.isArray(channelsRaw)) return undefined;
    const channels: AnimationChannel[] = [];
    for (const ch of channelsRaw) {
      if (typeof ch !== 'object' || ch === null) return undefined;
      const chObj = ch as Record<string, unknown>;
      const targetPath = chObj.targetPath;
      const property = chObj.property;
      const samplerObj = chObj.sampler as Record<string, unknown> | undefined;
      if (!Array.isArray(targetPath)) return undefined;
      if (property !== 'translation' && property !== 'rotation' && property !== 'scale')
        return undefined;
      if (samplerObj === undefined) return undefined;
      const inputRaw = samplerObj.input;
      const outputRaw = samplerObj.output;
      const interpolation = samplerObj.interpolation;
      let input: Float32Array;
      if (inputRaw instanceof Float32Array) {
        input = inputRaw;
      } else if (Array.isArray(inputRaw)) {
        input = new Float32Array(inputRaw as number[]);
      } else {
        return undefined;
      }
      let output: Float32Array;
      if (outputRaw instanceof Float32Array) {
        output = outputRaw;
      } else if (Array.isArray(outputRaw)) {
        output = new Float32Array(outputRaw as number[]);
      } else {
        return undefined;
      }
      if (interpolation !== 'LINEAR' && interpolation !== 'STEP') return undefined;
      channels.push({
        targetPath: targetPath as readonly string[],
        property: property as 'translation' | 'rotation' | 'scale',
        sampler: { input, output, interpolation },
      });
    }
    return { kind: 'animation-clip', duration, channels };
  },
};

/**
 * The seven inline pack-payload loaders, in the historical `if`-chain order.
 * `wireDefaultLoaders` (w5) registers these plus the texture / font loaders
 * (w6) and the audio placeholder (w8).
 */
export const INLINE_PACK_LOADERS: readonly Loader[] = [
  meshLoader,
  sceneLoader,
  cubeTextureLoader,
  materialLoader,
  skeletonLoader,
  skinLoader,
  animationClipLoader,
];

// === Upstream-branch loader bodies (feat-20260603-asset-import-loader-injection
// M1 / w6) ===
//
// texture / font are the two kinds that, pre-refactor, were dispatched on
// `entry.kind` in `loadByGuidProd` (above `parseAssetPayload`) through bespoke
// `loadTextureFromEntry` / `loadFontFromEntry` methods (research Finding 2).
// w6 extracts those bodies here as async loaders. They receive the catalog
// `entry` (relativeUrl + optional metadata) as the `payload` argument and use
// the injected `LoadContext` (`fetchBinary` / `resolveRef`) instead of reaching
// into `AssetRegistry` internals. They produce the `Asset` POD only;
// `registerWithGuid` stays in `loadByGuidProd` (D-2).
//
// M3 (feat-20260603-asset-import-loader-injection / w26, AC-15): the image
// decoder left the runtime. The static `@forgeax/engine-image` imports
// (`decodeImageInBrowser` / `decodeHdr`) and the dynamic node `parseImage`
// branch are gone -- the texture loader now reads ONLY a build-time-imported
// RGBA `.bin` produced by the `imageImporter` (engine-image), and a raw image
// source (`.jpg` / `.png` / `.hdr`) reaching the runtime loader is a misconfig
// that fails fast (charter P3) rather than triggering a runtime decode. The
// decode lives behind the build-time import pipeline (the runtime is the GPU
// consumer; the disk decoder is build-time only).

/** Catalog entry shape the texture / font loaders read from the `payload` slot. */
interface LoaderEntry {
  readonly guidKey: string;
  readonly relativeUrl: string;
  readonly kind: string;
  readonly metadata?: ImageMetadata | CubeTextureMetadata | undefined;
}

/** texture loader — fetch bytes -> hdr / import / dev decode -> TextureAsset POD. */
export const textureLoader: Loader = {
  kind: 'texture',
  load(payload, _refs, ctx): Promise<LoaderAsyncResult> {
    const entry = payload as unknown as LoaderEntry;
    return loadTextureAsset(entry, ctx);
  },
};

async function loadTextureAsset(entry: LoaderEntry, ctx: LoadContext): Promise<LoaderAsyncResult> {
  // feat-20260604-hdr-equirect-cube-importer-loader M2 / D-1 (import-state signal
  // converged 2026-06-06): the runtime reads only a build-time-imported RGBA
  // `.bin`. The `.bin` suffix is the SINGLE import-state judgement and it is
  // checked FIRST -- before the metadata check -- so an unimported texture row
  // always surfaces the dedicated `texture-source-not-imported` sentinel
  // (transport-eligible) regardless of whether its `metadata` is fully folded.
  // (Previously the metadata check ran first; a raw row missing width/height
  // returned the non-transport-eligible `image-meta-missing` ImageError and the
  // import-on-demand route was never reached.) `image-decode-failed` stays
  // reserved for a genuinely corrupt imported `.bin` and is never
  // transport-eligible, so a real decode failure is never silently lazy-imported.
  if (!entry.relativeUrl.endsWith('.bin')) {
    return {
      ok: false,
      error: new AssetError({
        code: 'texture-source-not-imported',
        expected: `a build-time-imported RGBA .bin for texture ${entry.relativeUrl}`,
        hint: ASSET_ERROR_HINTS['texture-source-not-imported'],
        detail: { sourcePath: entry.relativeUrl },
      }),
    };
  }

  const meta = entry.metadata;
  if (meta === undefined || meta.kind !== 'texture') {
    return {
      ok: false,
      error: makeImageError({
        code: 'image-meta-missing',
        sourcePath: entry.relativeUrl,
        expectedSidecarPath: `${entry.relativeUrl}.meta.json`,
      }),
    };
  }

  const fetched = await ctx.fetchBinary(entry.relativeUrl);
  if (!fetched.ok) return { ok: false, error: fetched.error };
  const bytes = fetched.value;

  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const levels = meta.mipmap === true ? numMipLevels({ width, height }) : 1;
  const texAsset: TextureAsset = {
    kind: 'texture',
    width,
    height,
    format: meta.format,
    data: bytes,
    colorSpace: meta.colorSpace,
    mipmap: meta.mipmap,
    mipLevelCount: levels,
  };
  return { ok: true, value: texAsset };
}

/** font loader — fetch pack JSON -> resolve atlas/sampler refs -> FontAsset POD. */
export const fontLoader: Loader = {
  kind: 'font',
  load(payload, _refs, ctx): Promise<LoaderAsyncResult> {
    const entry = payload as unknown as LoaderEntry;
    return loadFontAsset(entry, ctx);
  },
};

async function loadFontAsset(entry: LoaderEntry, ctx: LoadContext): Promise<LoaderAsyncResult> {
  const fetched = await ctx.fetchBinary(entry.relativeUrl);
  if (!fetched.ok) return { ok: false, error: fetched.error };
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(fetched.value)) as unknown;
  } catch {
    return {
      ok: false,
      error: new AssetError({
        code: 'asset-fetch-failed',
        expected: `font pack file ${entry.relativeUrl} to parse as JSON`,
        hint: ASSET_ERROR_HINTS['asset-fetch-failed'],
      }),
    };
  }

  const packFile = raw as {
    assets?: Array<{ guid: string; kind: string; payload: Record<string, unknown> }>;
  };
  const fontEntry = (packFile.assets ?? []).find(
    (a) => a.guid.toLowerCase() === entry.guidKey.toLowerCase(),
  );
  if (fontEntry === undefined) {
    return {
      ok: false,
      error: new AssetError({
        code: 'asset-not-found',
        expected: `GUID ${entry.guidKey} present in pack file ${entry.relativeUrl}`,
        hint: ASSET_ERROR_HINTS['asset-not-found'],
      }),
    };
  }
  const payloadObj = fontEntry.payload;

  const atlasGuidStr = payloadObj.atlasGuid;
  const samplerGuidStr = payloadObj.samplerGuid;
  if (typeof atlasGuidStr !== 'string' || typeof samplerGuidStr !== 'string') {
    return {
      ok: false,
      error: new AssetError({
        code: 'asset-parse-failed',
        expected: 'font pack payload to contain atlasGuid and samplerGuid string fields',
        hint: 'atlas texture and sampler GUIDs must be present in the font pack payload',
      }),
    };
  }

  const atlasResolved = await ctx.resolveRef(atlasGuidStr);
  if (!atlasResolved.ok) return { ok: false, error: atlasResolved.error };
  const samplerResolved = await ctx.resolveRef(samplerGuidStr);
  if (!samplerResolved.ok) return { ok: false, error: samplerResolved.error };

  const glyphsParsed = parseFontGlyphs(payloadObj.glyphs);
  if (!glyphsParsed.ok) return { ok: false, error: glyphsParsed.error };
  const commonParsed = parseFontCommon(payloadObj.common);
  if (!commonParsed.ok) return { ok: false, error: commonParsed.error };
  const notdef = parseFontNotdef(payloadObj.notdef);

  const fontAsset: FontAsset = {
    kind: 'font',
    atlas: toManaged<'TextureAsset'>(atlasResolved.value),
    sampler: toManaged<'SamplerAsset'>(samplerResolved.value),
    glyphs: glyphsParsed.value,
    common: commonParsed.value,
    ...(notdef !== undefined ? { notdef } : {}),
  };
  return { ok: true, value: fontAsset };
}

/** Parse the font payload `glyphs` Record into typed GlyphMetric entries. */
function parseFontGlyphs(
  glyphsRaw: unknown,
): { ok: true; value: FontAsset['glyphs'] } | { ok: false; error: AssetError } {
  if (typeof glyphsRaw !== 'object' || glyphsRaw === null) {
    return {
      ok: false,
      error: new AssetError({
        code: 'asset-parse-failed',
        expected: 'glyphs field to be a Record<number, GlyphMetric>',
        hint: `got ${typeof glyphsRaw}`,
      }),
    };
  }
  const glyphs: FontAsset['glyphs'] = {};
  for (const [codepointStr, g] of Object.entries(glyphsRaw as Record<string, unknown>)) {
    const codepoint = Number(codepointStr);
    if (Number.isNaN(codepoint)) continue;
    if (typeof g !== 'object' || g === null) continue;
    const m = g as Record<string, unknown>;
    const size = m.size as Record<string, unknown> | undefined;
    const region = m.region as Record<string, unknown> | undefined;
    if (
      typeof m.advance !== 'number' ||
      typeof m.bearingX !== 'number' ||
      typeof m.bearingY !== 'number' ||
      typeof size !== 'object' ||
      size === null ||
      typeof size.w !== 'number' ||
      typeof size.h !== 'number' ||
      typeof region !== 'object' ||
      region === null ||
      typeof region.x !== 'number' ||
      typeof region.y !== 'number' ||
      typeof region.w !== 'number' ||
      typeof region.h !== 'number'
    ) {
      continue;
    }
    glyphs[codepoint] = {
      advance: m.advance,
      bearingX: m.bearingX,
      bearingY: m.bearingY,
      size: { w: size.w, h: size.h },
      region: { x: region.x, y: region.y, w: region.w, h: region.h },
    };
  }
  return { ok: true, value: glyphs };
}

/** Parse the font payload `common` block. */
function parseFontCommon(
  commonRaw: unknown,
): { ok: true; value: FontAsset['common'] } | { ok: false; error: AssetError } {
  if (typeof commonRaw !== 'object' || commonRaw === null) {
    return {
      ok: false,
      error: new AssetError({
        code: 'asset-parse-failed',
        expected: 'common field to be present',
        hint: `got ${typeof commonRaw}`,
      }),
    };
  }
  const cm = commonRaw as Record<string, unknown>;
  if (
    typeof cm.lineHeight !== 'number' ||
    typeof cm.base !== 'number' ||
    typeof cm.distanceRange !== 'number' ||
    typeof cm.pxRange !== 'number' ||
    typeof cm.atlasWidth !== 'number' ||
    typeof cm.atlasHeight !== 'number'
  ) {
    return {
      ok: false,
      error: new AssetError({
        code: 'asset-parse-failed',
        expected: 'common block to contain all required number fields',
        hint: 'common block must have lineHeight, base, distanceRange, pxRange, atlasWidth, atlasHeight',
      }),
    };
  }
  return {
    ok: true,
    value: {
      lineHeight: cm.lineHeight,
      base: cm.base,
      distanceRange: cm.distanceRange,
      pxRange: cm.pxRange,
      atlasWidth: cm.atlasWidth,
      atlasHeight: cm.atlasHeight,
    },
  };
}

/** Parse the optional font payload `notdef` glyph. */
function parseFontNotdef(notdefRaw: unknown): FontAsset['notdef'] | undefined {
  if (typeof notdefRaw !== 'object' || notdefRaw === null) return undefined;
  const nd = notdefRaw as Record<string, unknown>;
  if (
    typeof nd.advance !== 'number' ||
    typeof nd.bearingX !== 'number' ||
    typeof nd.bearingY !== 'number'
  ) {
    return undefined;
  }
  const size = nd.size as Record<string, unknown> | undefined;
  const region = nd.region as Record<string, unknown> | undefined;
  return {
    advance: nd.advance,
    bearingX: nd.bearingX,
    bearingY: nd.bearingY,
    size: {
      w: typeof size?.w === 'number' ? size.w : 0,
      h: typeof size?.h === 'number' ? size.h : 0,
    },
    region: {
      x: typeof region?.x === 'number' ? region.x : 0,
      y: typeof region?.y === 'number' ? region.y : 0,
      w: typeof region?.w === 'number' ? region.w : 0,
      h: typeof region?.h === 'number' ? region.h : 0,
    },
  };
}

/**
 * The two upstream-branch loaders that consume a catalog entry directly
 * (research Finding 2): they are dispatched from `loadByGuidProd` off the entry
 * (not via the `.pack.json` -> parseAssetPayload path). `UPSTREAM_ENTRY_KINDS`
 * lets `loadByGuidProd` route to them without a hardcoded `if (entry.kind ===
 * ...)` chain (AC-01); it is derived from the loader objects so the kind
 * strings have one source.
 */
export const UPSTREAM_ENTRY_LOADERS: readonly Loader[] = [textureLoader, fontLoader];
const UPSTREAM_ENTRY_KINDS: ReadonlySet<string> = new Set(
  UPSTREAM_ENTRY_LOADERS.map((l) => l.kind),
);

interface InspectEntry {
  readonly id: number;
  readonly brand: AssetBrand;
  readonly refcount: 'immortal';
}

interface InspectSnapshot {
  readonly handles: ReadonlyArray<InspectEntry>;
}

/**
 * Asset registry (instance-per-engine; `engine.assets: AssetRegistry | null`).
 *
 * Pre-populated with `HANDLE_CUBE` and `HANDLE_TRIANGLE` at construction time
 * (charter proposition 1: AI users see usable handles in the very first
 * frame without registration ceremony).
 *
 * @example Register a texture by GUID and spawn a material:
 * ```ts
 * const guid = AssetGuid.parse('00000000-0000-7000-8000-000000000001');
 * const handle = engine.assets.registerWithGuid(guid, myTexture);
 * const res = await engine.assets.loadByGuid(guid);
 * if (!res.ok) {
 *   switch (res.error.code) {
 *     case 'asset-not-found':  // guid not registered
 *   }
 *   return;
 * }
 * world.spawn({
 *   component: MeshRenderer,
 *   data: { material: registry.register({ kind: 'material', shadingModel: 'standard', baseColorTexture: res.value }) },
 * });
 * ```
 */

/**
 * Register-stage fail-fast for `kind: 'mesh'` payloads whose vertices buffer
 * is not the canonical 12-floats-per-vertex layout.
 *
 * Validation spec (plan-strategy D-3):
 *   (a) asset.kind !== 'mesh' -> return null immediately
 *   (b) vertices.length === 0 && indices.length === 0 -> return null (empty mesh legal)
 *   (c) vertices.length % 12 !== 0 -> `AssetError` with code='mesh-vertex-stride-mismatch',
 *       detail = { vertexCount: 0, floatsPerVertex: vertices.length / 12 } (non-integer)
 *   (d) otherwise compute vertexCount = vertices.length / 12; scan indices for maxIndex;
 *       if maxIndex + 1 !== vertexCount -> same AssetError shape with
 *       detail = { vertexCount: maxIndex + 1, floatsPerVertex: vertices.length / (maxIndex + 1) }
 *
 * Isomorphic with `validateMaterialPayload` — both are private module-level helpers,
 * both return `AssetError | null`, and both are called from `register()` at entry.
 *
 * Anchors: charter P3 (structured failure); plan-strategy D-2 (gate at register stage);
 *          plan-strategy D-3 (three-branch validation: empty / non-divisible-12 / maxIndex mismatch);
 *          plan-strategy D-5 (physical location co-located with validateMaterialPayload).
 */
function validateMeshPayload(asset: Asset): AssetError | null {
  if (asset.kind !== 'mesh') return null;

  // feat-20260604-mesh-topology-debug-draw M5 / w13: semantic topology gate
  // (plan-strategy D-A2).
  //
  // feat-20260608 M2 / w9: topology is now per-submesh (MeshAsset.submeshes[]).
  // All topology + submesh-empty + index-OOB validation runs here.
  const submeshes = (asset as TypesMeshAsset).submeshes;
  if (submeshes.length === 0) {
    // TypesMeshAsset POD does not carry an inline GUID; the registry assigns
    // one on register, but at validation time we only have the payload. Emit
    // a stable sentinel so the closed AssetErrorDetail union still narrows.
    const guid = '<no-guid>';
    return new AssetError({
      code: 'mesh-asset-submeshes-empty',
      expected: 'submeshes array has at least one Submesh entry',
      hint: ASSET_ERROR_HINTS['mesh-asset-submeshes-empty'],
      detail: { meshAssetGuid: guid },
    });
  }

  const hasIndices = (asset.indices?.length ?? 0) > 0;
  const indexBufferLength = asset.indices?.length ?? 0;
  for (let i = 0; i < submeshes.length; i++) {
    const sm = submeshes[i];
    if (sm === undefined) continue;
    const topology = sm.topology;
    if ((topology === 'line-strip' || topology === 'triangle-strip') && !hasIndices) {
      return new AssetError({
        code: 'asset-invalid-value',
        expected: `submesh[${i}] strip topology carries an index buffer`,
        hint: 'line-strip / triangle-strip meshes must provide indices; add MeshAsset.indices or use line-list / triangle-list',
        detail: {
          field: `submeshes[${i}].topology`,
          value: topology,
          reason: 'strip-topology-without-indices',
        },
      });
    }
    if (asset.vertices.length === 0 && topology !== 'triangle-list') {
      return new AssetError({
        code: 'asset-invalid-value',
        expected: `submesh[${i}]: empty geometry uses 'triangle-list'`,
        hint: 'a zero-vertex mesh has nothing to draw; change submesh topology to triangle-list or provide vertices',
        detail: {
          field: `submeshes[${i}].topology`,
          value: topology,
          reason: 'empty-geometry-non-default-topology',
        },
      });
    }
    // feat-20260608 M2 / w9: index-range-out-of-bounds per submesh
    if (sm.indexOffset + sm.indexCount > indexBufferLength) {
      // TypesMeshAsset POD does not carry an inline GUID; the registry assigns
      // one on register, but at validation time we only have the payload. Emit
      // a stable sentinel so the closed AssetErrorDetail union still narrows.
      const guid = '<no-guid>';
      return new AssetError({
        code: 'mesh-submesh-index-range-out-of-bounds',
        expected: `submesh[${i}].indexOffset + indexCount <= index buffer length (${indexBufferLength})`,
        hint: ASSET_ERROR_HINTS['mesh-submesh-index-range-out-of-bounds'],
        detail: {
          submeshIndex: i,
          indexOffset: sm.indexOffset,
          indexCount: sm.indexCount,
          indexBufferLength,
          meshAssetGuid: guid,
        },
      });
    }
  }

  // indices is optional (vertex-only meshes omit it); read defensively. The
  // stride invariant below stays null-safe for vertex-only meshes (D-A4).
  if (asset.vertices.length === 0 && (asset.indices?.length ?? 0) === 0) return null;

  // Skin-aware stride: when MeshAsset.attributes carries skinIndex + skinWeight,
  // the bridge promotes the interleaved buffer to 18 floats/vertex (12 base +
  // 4 uint16x4 packed via aliased Uint16 view at slots 12-13 + 4 float weights
  // at slots 14-17). Charter-aligned: the validator must mirror the same shape
  // the bridge produces, otherwise indexed skinned meshes (every Mixamo / most
  // glTF exports) fail with a stride that is structurally correct.
  const attrs = (asset as TypesMeshAsset).attributes;
  const isSkinned =
    attrs !== undefined && attrs.skinIndex !== undefined && attrs.skinWeight !== undefined;
  const floatsPerVertex = isSkinned ? 18 : 12;

  if (asset.vertices.length % floatsPerVertex !== 0) {
    return new AssetError({
      code: 'mesh-vertex-stride-mismatch',
      expected: isSkinned
        ? '18 floats per vertex (= position vec3 + normal vec3 + uv vec2 + tangent vec4 + skinIndex u16x4 + skinWeight vec4)'
        : '12 floats per vertex (= position vec3 + normal vec3 + uv vec2 + tangent vec4)',
      hint: ASSET_ERROR_HINTS['mesh-vertex-stride-mismatch'],
      detail: {
        vertexCount: 0,
        floatsPerVertex: asset.vertices.length / floatsPerVertex,
      },
    });
  }

  const vertexCount = asset.vertices.length / floatsPerVertex;
  // Vertex-only meshes (no indices) skip the maxIndex-vs-vertexCount invariant:
  // there is no index buffer to bound-check against the vertex array (D-A4).
  const indices = asset.indices;
  if (indices === undefined || indices.length === 0) return null;
  let maxIndex = 0;
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    if (idx !== undefined && idx > maxIndex) maxIndex = idx;
  }

  if (maxIndex + 1 !== vertexCount) {
    return new AssetError({
      code: 'mesh-vertex-stride-mismatch',
      expected: isSkinned
        ? '18 floats per vertex (= position vec3 + normal vec3 + uv vec2 + tangent vec4 + skinIndex u16x4 + skinWeight vec4)'
        : '12 floats per vertex (= position vec3 + normal vec3 + uv vec2 + tangent vec4)',
      hint: ASSET_ERROR_HINTS['mesh-vertex-stride-mismatch'],
      detail: {
        vertexCount: maxIndex + 1,
        floatsPerVertex: vertexCount > 0 ? asset.vertices.length / (maxIndex + 1) : 0,
      },
    });
  }

  return null;
}

/**
 * Compute the local-space AABB of a mesh from its position attribute.
 *
 * Reads every third float from the position buffer as (x, y, z) and computes
 * [minX, minY, minZ, maxX, maxY, maxZ]. When position is absent, empty, or
 * less than 3 floats, returns an inverted-infinity empty box ([+Inf,+Inf,+Inf,
 * -Inf,-Inf,-Inf]) — consumers interpret this as "always-visible" (no culling).
 *
 * The position attribute can be Float32Array, ArrayBuffer (re-wrapped as
 * Float32Array), or Uint16Array (unlikely for position data; treated as
 * absent). Empty vertices (0 x 12 = 0) also produce empty box.
 *
 * Anchors: plan-strategy D-7 (register-time computation); D-1 (Float32Array
 * bare type); requirements AC-02 (empty -> inverted-infinity).
 */
function computeAABB(asset: TypesMeshAsset): Float32Array {
  const pos = asset.attributes.position;
  // Convert to Float32Array if possible; bail to empty-box otherwise.
  let floatPos: Float32Array;
  if (pos instanceof Float32Array) {
    floatPos = pos;
  } else if (pos instanceof ArrayBuffer) {
    floatPos = new Float32Array(pos);
  } else {
    return emptyBox();
  }
  if (floatPos.length < 3) return emptyBox();

  let minX = floatPos[0] ?? 0;
  let minY = floatPos[1] ?? 0;
  let minZ = floatPos[2] ?? 0;
  let maxX = minX;
  let maxY = minY;
  let maxZ = minZ;
  for (let i = 3; i < floatPos.length; i += 3) {
    const x = floatPos[i] ?? 0;
    const y = floatPos[i + 1] ?? 0;
    const z = floatPos[i + 2] ?? 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return Float32Array.of(minX, minY, minZ, maxX, maxY, maxZ);
}

function emptyBox(): Float32Array {
  return Float32Array.of(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
}

// Assigns the computed AABB to the mesh in place when the object is
// extensible; falls back to a shallow copy when frozen / sealed (e.g.
// BUILTIN_CUBE / BUILTIN_TRIANGLE / BUILTIN_QUAD reused via registerWithGuid).
function withMeshAabb(asset: TypesMeshAsset): TypesMeshAsset {
  const aabb = computeAABB(asset);
  if (Object.isExtensible(asset)) {
    (asset as { aabb: Float32Array }).aabb = aabb;
    return asset;
  }
  return { ...asset, aabb };
}

// bug-20260610 Fix B: parsed pack-file body stored in the fetchPackFile
// in-memory cache + in-flight dedup maps (D-4). Only the raw JSON shape is
// cached -- parseAssetPayload still runs per-call to look up the per-GUID
// entry (CON-2 register-before-recurse cycle safety).
interface ParsedPackFile {
  assets: Array<{
    guid: string;
    kind: string;
    payload: Record<string, unknown>;
    refs?: string[];
  }>;
}

export class AssetRegistry {
  private readonly assets: Map<number, Asset> = new Map();
  private nextHandle: number = FIRST_USER_HANDLE;
  private readonly guidToHandle: Map<string, Handle<string, 'unmanaged'>> = new Map();
  private readonly handleToGuid: Map<number, AssetGuid> = new Map();

  // ─── Prod pack-index fetch state (M4/w23) ──────────────────────────────
  // When packIndexUrl is configured, loadByGuid fetches pack-index.json on
  // first call, caches the parsed catalog in packIndexCache, then fetches
  // the individual resource file and registers the asset.
  private packIndexUrl: string | undefined = undefined;
  private packIndexCache:
    | Map<
        string,
        {
          relativeUrl: string;
          kind: string;
          metadata?: ImageMetadata | CubeTextureMetadata | undefined;
        }
      >
    | undefined = undefined;

  // tweak-20260609 M1: in-flight Map for recursive loadByGuid dedup + cycle
  // prevention (D-5 / B-10). Maps guidKey → Promise<Result<Handle, ...>> so
  // concurrent calls for the same GUID share the same fetch + register chain,
  // and cycles (A→B→A) terminate when the second visit hits the in-flight
  // entry for A instead of re-entering fetch.
  private readonly inFlight: Map<
    string,
    Promise<Result<Handle<string, 'unmanaged'>, AssetError | ImageError | RhiError>>
  > = new Map();

  // bug-20260610 Fix B (M3 / D-4): per-instance pack-file cache keyed by
  // relativeUrl (the .pack.json URL). `packFileInFlight` de-duplicates
  // concurrent fetches; `packFileCache` stores resolved bodies so the
  // same URL is fetched at most once per AssetRegistry lifetime (CON-6).
  private readonly packFileCache: Map<string, ParsedPackFile> = new Map();
  private readonly packFileInFlight: Map<string, Promise<ParsedPackFile>> = new Map();

  // feat-20260528-scene-asset-guid-refs-and-post-instantiate M1-fixup F-2:
  // stores the most recent ParseSceneError from parseScenePayload so
  // fetchPackFile can construct a precise AssetError with localId,
  // component, field, index, and refs.length.
  private lastParseSceneError: ParseSceneError | undefined = undefined;

  // feat-20260527-sprite-nineslice M4 / w16 + w18 (D-5 + D-9): per-Renderer
  // EngineMetrics shared with the runtime so register-time soft-warns
  // (`nineslice.tile-needs-repeat-sampler` for sliceMode=1 + sampler not
  // 'repeat') and runtime soft-warns (`nineslice.scale-too-small`) increment
  // the SAME counter map. `createRenderer.ts` calls `assets.setMetrics(metrics)`
  // immediately after constructing the registry; standalone test fixtures
  // that do not go through `createRenderer` may leave this null and the
  // soft-warn paths simply no-op (charter P9 graceful degradation: the
  // structured fail-fast branches still fire; only the metric is dropped).
  private metrics: EngineMetrics | null = null;

  /**
   * Construct a fresh registry pre-populated with the builtin cube + triangle
   * mesh handles (`HANDLE_CUBE` / `HANDLE_TRIANGLE`).
   *
   * feat-20260514 M3 / w15: the previous optional `RhiDevice` constructor
   * argument (consumed by the now-deleted `createInstancedBuffer` triplet)
   * is removed; the registry surface is engine-agnostic again. Per-entity
   * instance transforms now live inside the ECS `Instances { transforms:
   * 'array<f32>' }` component; the RenderSystem record stage owns GPU
   * storage buffer allocation + cap-gate.
   */
  // feat-20260603-asset-import-loader-injection M1: the registry dispatches
  // `parseAssetPayload` / the texture+font upstream branches through this
  // constructor-injected `LoaderRegistry` (D-1 / D-7) instead of a hardcoded
  // `if (kind === ...)` chain. Injected at construction (no setter, no illegal
  // intermediate state); the production assembly point + tests pass a registry
  // wired by `wireDefaultLoaders` / `createDefaultLoaderRegistry`.
  private readonly loaders: LoaderRegistry;

  // feat-20260603-asset-import-loader-injection M4 / w31 (AC-19 / AC-22):
  // the optional `ImportTransport` is the *only* difference between the studio
  // form (transport injected, dev DDC miss triggers lazy import) and the shipped
  // form (transport absent, DDC miss fails fast with `asset-not-imported`).
  // The load path AFTER a successful DDC fetch is identical in both forms --
  // zero branching on transport (AC-23 key invariant). Set at construction (no
  // setter, no illegal intermediate state), same D-7 stance as LoaderRegistry.
  private readonly importTransport: ImportTransport | undefined;

  /** @internal Stored for M2 validation; TS suppressor reference */
  constructor(
    private readonly shaderRegistry: ShaderRegistry,
    loaders: LoaderRegistry,
    importTransport?: ImportTransport | undefined,
  ) {
    void this.shaderRegistry;
    this.loaders = loaders;
    this.importTransport = importTransport;
    this.assets.set(unwrapHandle(HANDLE_CUBE), BUILTIN_CUBE);
    this.assets.set(unwrapHandle(HANDLE_TRIANGLE), BUILTIN_TRIANGLE);
    this.assets.set(unwrapHandle(HANDLE_QUAD), BUILTIN_QUAD);
    this.assets.set(unwrapHandle(HANDLE_SPHERE), BUILTIN_SPHERE);
    this.assets.set(unwrapHandle(HANDLE_NINESLICE_QUAD), BUILTIN_NINESLICE_QUAD);
    // Register the builtin GUID <-> handle pairing in both directions so the
    // builtins are first-class GUID-addressable assets: guidOf(HANDLE_CUBE)
    // resolves, resolveGuid(cubeGuid) returns HANDLE_CUBE, and scene refs[]
    // pointing at a builtin GUID resolve without a hand-maintained table
    // (docs/feedbacks/2026-06-03 §6.2 Tier 0).
    for (const [handle, guidStr] of BUILTIN_MESH_GUIDS) {
      const parsed = AssetGuid.parse(guidStr);
      if (!parsed.ok) {
        throw new Error(`[asset-registry] builtin GUID ${guidStr} is not a valid UUID`);
      }
      this.guidToHandle.set(guidStr, handle);
      this.handleToGuid.set(unwrapHandle(handle), parsed.value);
    }
  }

  /**
   * feat-20260527-sprite-nineslice M4 / w16 prep + w18 (D-5 + D-9): inject the
   * per-Renderer `EngineMetrics` so register-time soft-warns can bump the same
   * counter map the runtime reads through `renderer.metrics.snapshot()`. Called
   * by `createRenderer` after constructing both the registry and the metrics
   * instance; safe to skip in standalone tests (the soft-warn arms simply do
   * not record).
   */
  setMetrics(metrics: EngineMetrics): void {
    this.metrics = metrics;
  }

  /**
   * @internal — read the metrics handle for register-time soft-warn paths.
   * Returns `null` when no `createRenderer` wired the registry to a renderer
   * (the standalone-test path; the structured fail-fast branches still fire).
   */
  _getMetrics(): EngineMetrics | null {
    return this.metrics;
  }

  /**
   * Configure the production pack-index URL for `loadByGuid`.
   *
   * Call this once during engine initialization with the URL where
   * `pack-index.json` is served (emitted by `@forgeax/engine-vite-plugin-pack`
   * during `vite build`). After configuration, `loadByGuid` will fetch
   * the catalog on its first invocation and cache it for subsequent calls.
   *
   * @example
   * ```ts
   * engine.assets.configurePackIndex('/pack-index.json');
   * const handle = await engine.assets.loadByGuid(guid);
   * ```
   */
  configurePackIndex(url: string): void {
    this.packIndexUrl = url;
    this.packIndexCache = undefined; // reset cache if URL changes
  }

  /**
   * Materialise a `SceneAsset` into an existing `World` and return the
   * synthetic root `Entity` (feat-20260514 w31 sugar wrapper; AC-03 +
   * requirements §IN-3; M3: returns Entity not SceneInstanceId).
   *
   * Before spawning, handle-type component fields (e.g. `assetHandle`,
   * `material`, `skeleton`) containing GUID strings are resolved to
   * `Handle` numbers via `resolveGuid` (feat-20260528-scene-asset-guid-refs
   * -and-post-instantiate M2 / w6; plan-strategy D-1 two-phase parse).
   * GUIDs that fail to parse or are not registered return
   * `AssetError(code='asset-not-found')` with a hint containing the GUID,
   * node localId, and field name.
   *
   * Errors propagate verbatim through the closed
   * `AssetError | PackError | EcsError` union so AI users that already
   * narrow `loadByGuid<SceneAsset>` results reuse the same `switch
   * (err.code)` exhaustively (charter proposition 3 machine-readable
   * union; plan-strategy §3.3 closed-union transparency).
   *
   * @example
   * ```ts
   * const handleRes = await engine.assets.loadByGuid<SceneAsset>(roomGuid);
   * if (!handleRes.ok) return;
   * const r = engine.assets.instantiate(handleRes.value, world);
   * if (!r.ok) {
   *   switch (r.error.code) {
   *     case 'asset-not-found':
   *     case 'pack-cyclic-reference':
   *     // ... AssetErrorCode | PackErrorCode | EcsErrorCode exhaustive
   *   }
   * }
   * ```
   */
  instantiate<T extends SceneAsset>(
    handle: Handle<TagOf<T>, 'unmanaged'>,
    world: World,
    parent?: EntityHandle,
  ): Result<EntityHandle, AssetError | PackError | EcsError> {
    // Resolve GUID strings in handle-type component fields to Handle numbers
    // before ecs spawn (plan-strategy D-1 two-phase: parse->GUID then
    // instantiate-time GUID->Handle). Only runs when the SceneAsset is
    // present in this AssetRegistry (the handle was registered via
    // register / registerWithGuid / loadByGuid). When the asset is not in
    // the registry (e.g. the handle was resolved by an external
    // SceneAssetResolver), skip GUID resolution and fall through to the
    // original ecs-only path.
    let instantiateResult: Result<EntityHandle, AssetError | PackError | EcsError>;
    const sceneAsset = this.assets.get(unwrapHandle(handle));
    if (sceneAsset !== undefined && sceneAsset.kind === 'scene') {
      const sceneRes = this._resolveSceneGuids(sceneAsset, world);
      if (!sceneRes.ok) return sceneRes;

      // Register the GUID-resolved SceneAsset as a managed ref so
      // world._resolveSceneAsset (the managed-ref fallback in
      // instantiateScene) can resolve it transparently. The managed ref
      // is released by world.despawn (the `ref<T>` release loop) or
      // explicitly via despawnScene.
      const managed = world.allocManagedRef('SceneAsset', sceneRes.value);
      const unmanagedHandle = toUnmanaged<'SceneAsset'>(managed as unknown as number);
      instantiateResult = world.instantiateScene(unmanagedHandle, parent) as unknown as Result<
        EntityHandle,
        AssetError | PackError | EcsError
      >;
      if (!instantiateResult.ok) return instantiateResult;
    } else {
      // Non-registered handle: original ecs direct path (backward compat).
      instantiateResult = world.instantiateScene(
        handle as Handle<'SceneAsset', 'unmanaged'>,
        parent,
      ) as unknown as Result<EntityHandle, AssetError | PackError | EcsError>;
      if (!instantiateResult.ok) return instantiateResult;
    }

    // Post-spawn hook: auto-wire Skin.joints from jointPaths (v1 missing item #2).
    // The resolver maps a SkeletonAsset handle to the matching SkinAsset's
    // jointPaths by cross-referencing the internal handle->guid index and
    // converting the skeleton GUID to dash-form string for comparison.
    // tweak-20260611 D-7: pass the spawn root entity so the resolver scopes
    // its Name index to the spawn's ChildOf descendants — without it, multiple
    // instantiate() calls on the same SceneAsset would all wire to the first
    // spawn's joint entities (same-name-sibling collision across instances).
    const self = this;
    const jointResolveResult = postSpawnResolveJoints(
      world,
      {
        resolveSkinAsset(skeletonHandleRaw: number) {
          const skeletonGuid = self.handleToGuid.get(skeletonHandleRaw);
          if (skeletonGuid === undefined) return undefined;
          const skeletonGuidStr = bytesToUuid(skeletonGuid);
          for (const [, asset] of self.assets) {
            if (asset.kind === 'skin' && asset.skeletonGuid === skeletonGuidStr) {
              return asset;
            }
          }
          return undefined;
        },
      },
      instantiateResult.value,
    );
    if (!jointResolveResult.ok) {
      return { ok: false, error: jointResolveResult.error } as unknown as Result<
        EntityHandle,
        AssetError | PackError | EcsError
      >;
    }

    return instantiateResult;
  }

  /**
   * @internal
   * Transform a SceneAsset whose handle-type component fields hold GUID
   * strings (post-parseScenePayload intermediate state) into a copy whose
   * handle fields hold resolved Handle numbers.
   *
   * Schema-driven field detection (plan-strategy D-4): for each component
   * field whose Component.schema fieldType starts with `'handle<'`, the
   * value is treated as a GUID string and resolved via `AssetGuid.parse` +
   * `this.resolveGuid`. Unknown component names are silently passed through
   * (the ecs layer's additionalProperties check will catch unknowns at
   * spawn if appropriate).
   *
   * Stop-on-first-error (AC-08): the first unresolvable GUID aborts
   * iteration and returns `AssetError(code='asset-not-found')` with a hint
   * containing the GUID string, node localId, and field name for AI-user
   * debuggability (P3).
   */
  _resolveSceneGuids(scene: SceneAsset, _world: World): Result<SceneAsset, AssetError> {
    // D-4 / B-5 / IN-4: delegate handle-field detection to the shared helper
    // (extractSceneEntityHandleGuids) so "identify handle<...> fields" lives in
    // exactly one authoritative location.
    const entries = extractSceneEntityHandleGuids(
      scene.entities as unknown as ReadonlyArray<{
        readonly localId: number;
        readonly components: Record<string, Record<string, unknown>>;
      }>,
    );

    // Resolve every detected GUID string → Handle number. Stop on first error
    // (AC-08); the error format (code, hint, expected) is identical to the
    // pre-D-4 inline version so existing resolve-scene-guids tests pass byte-for-byte.
    const resolvedMap = new Map<string, number>();
    for (const entry of entries) {
      const fieldPath =
        `${entry.componentName}.${entry.fieldName}` +
        (entry.arrayIndex !== undefined ? `[${entry.arrayIndex}]` : '');

      const guidRes = AssetGuid.parse(entry.guidString);
      if (!guidRes.ok) {
        return err(
          new AssetError({
            code: 'asset-not-found',
            expected: `valid GUID string for field ${fieldPath}`,
            hint:
              `GUID "${entry.guidString}" could not be parsed; ` +
              `at node localId=${entry.entityLocalId}, field=${fieldPath}`,
          }),
        );
      }
      const handleRes = this.resolveGuid(guidRes.value);
      if (!handleRes.ok) {
        return err(
          new AssetError({
            code: 'asset-not-found',
            expected: `GUID ${entry.guidString} registered in AssetRegistry`,
            hint:
              `GUID ${entry.guidString} not registered; ` +
              `call loadByGuid('${entry.guidString}') before instantiate; ` +
              `at node localId=${entry.entityLocalId}, field=${fieldPath}`,
          }),
        );
      }

      const key =
        `${entry.entityLocalId}|${entry.componentName}|${entry.fieldName}` +
        (entry.arrayIndex !== undefined ? `|${entry.arrayIndex}` : '|');
      resolvedMap.set(key, unwrapHandle(handleRes.value));
    }

    // Build the resolved copy. Handle-type fields (detected above) are
    // reconstructed from the resolvedMap; all other fields pass through as-is.
    const resolvedNodes: SceneEntity[] = [];
    for (const node of scene.entities) {
      const rawComponents = node.components as Record<string, Record<string, unknown>>;
      const resolvedComponents: Record<string, Record<string, unknown>> = {};

      for (const compName of Object.keys(rawComponents)) {
        const rawFields = rawComponents[compName];
        if (!rawFields) {
          resolvedComponents[compName] = {};
          continue;
        }
        const resolvedFields: Record<string, unknown> = {};
        for (const fieldName of Object.keys(rawFields)) {
          const value = rawFields[fieldName];
          const plainKey = `${node.localId}|${compName}|${fieldName}|`;
          const plainResolved = resolvedMap.get(plainKey);
          if (plainResolved !== undefined) {
            resolvedFields[fieldName] = plainResolved;
          } else if (Array.isArray(value)) {
            const resolvedArr: number[] = [];
            let hasAnyResolved = false;
            for (let i = 0; i < value.length; i++) {
              const arrKey = `${node.localId}|${compName}|${fieldName}|${i}`;
              const arrResolved = resolvedMap.get(arrKey);
              if (arrResolved !== undefined) {
                resolvedArr.push(arrResolved);
                hasAnyResolved = true;
              } else if (typeof value[i] === 'number') {
                resolvedArr.push(value[i]);
              }
            }
            resolvedFields[fieldName] = hasAnyResolved ? resolvedArr : value;
          } else {
            resolvedFields[fieldName] = value;
          }
        }
        resolvedComponents[compName] = resolvedFields;
      }
      resolvedNodes.push({
        localId: node.localId,
        components: resolvedComponents,
      });
    }
    return ok({ kind: 'scene', entities: resolvedNodes });
  }

  /**
   * Validate a MaterialAsset's passes[] against the ShaderRegistry's
   * paramSchema (union semantics: all declared params across all passes
   * must be satisfiable from paramValues).
   *
   * - Empty / undefined passes[] → error
   * - Each pass's shader must exist in ShaderRegistry
   * - Union of all pass paramSchemas: params without `default` must
   *   appear in paramValues with matching type
   * - Extra keys in paramValues are silently ignored (D-5)
   *
   * @returns AssetError on failure, null on success
   */
  private validateMaterialPasses(asset: MaterialAsset): AssetError | null {
    const passes = asset.passes;
    // undefined passes is valid (material inherits from parent at resolve time);
    // only explicit empty passes[] is an error.
    if (passes === undefined || passes.length === 0) {
      if (passes !== undefined && passes.length === 0) {
        return new AssetError({
          code: 'asset-invalid-value',
          expected: 'MaterialAsset with at least one pass',
          hint: 'add at least one pass descriptor to passes[] before register',
          detail: { passCount: 0 },
        });
      }
      // passes undefined: skip validation (inherits from parent later)
      return null;
    }

    const allSchemas: ParamSchemaEntry[] = [];
    for (let passIndex = 0; passIndex < passes.length; passIndex++) {
      const pass = passes[passIndex];
      if (pass === undefined) continue;
      const lookup = this.shaderRegistry.lookupMaterialShader(pass.shader);
      if (!lookup.ok) {
        return new AssetError({
          code: 'asset-invalid-value',
          expected: `shader '${pass.shader}' registered in ShaderRegistry`,
          hint: `pass[${passIndex}] references shader '${pass.shader}' which is not registered; register it via ShaderRegistry.registerMaterialShader('${pass.shader}', ...) at engine boot`,
          detail: { passIndex, shaderKey: pass.shader, cause: 'shader-not-found' },
        });
      }
      for (const entry of lookup.value.paramSchema) {
        allSchemas.push(entry);
      }
    }

    // Deduplicate by name (first occurrence wins)
    const seen = new Set<string>();
    const unionSchema: ParamSchemaEntry[] = [];
    for (const entry of allSchemas) {
      if (!seen.has(entry.name)) {
        seen.add(entry.name);
        unionSchema.push(entry);
      }
    }

    const paramValues: Record<string, unknown> =
      (asset.paramValues as Record<string, unknown>) ?? {};

    // feat-20260613-material-paramschema-driven-binding M3 / w16 (D-2):
    // derive(schema) is the SSOT for which schema fields are textures vs
    // samplers vs numeric. The register-time three-layer validation (extra-
    // key / type-mismatch / missing-required) categorizes fields via
    // derive output instead of a hardcoded literal type list. Texture
    // and sampler fields are always optional at register time (the
    // resource handles may not be available yet — D-5 graceful path),
    // so derive-derived membership decides the skip set without keeping
    // a parallel literal table.
    const derived = derive(unionSchema);
    const textureFields = derived.textureFieldNames;
    const samplerFields = new Set<string>();
    for (const e of unionSchema) {
      if (e.type === 'sampler' || e.type === 'sampler_comparison') {
        samplerFields.add(e.name);
      }
    }

    const missingParams: string[] = [];
    for (const entry of unionSchema) {
      // Param with default: skip if missing in paramValues
      if (entry.default !== undefined) {
        continue;
      }
      // Texture / sampler params are always optional at register time
      // (asset handles may not be available yet); derive output is the
      // SSOT for category membership.
      if (textureFields.has(entry.name) || samplerFields.has(entry.name)) {
        continue;
      }
      const value = paramValues[entry.name];
      if (value === undefined) {
        missingParams.push(entry.name);
        continue;
      }
      // Type-check supplied values
      const typeOk = this.validateParamType(entry.name, entry.type, value);
      if (!typeOk) {
        return new AssetError({
          code: 'asset-invalid-value',
          expected: `paramValues.${entry.name} to be of type ${entry.type}`,
          hint: `paramValues['${entry.name}'] has type ${typeof value} but paramSchema declares ${entry.type}`,
          detail: { paramName: entry.name, expectedType: entry.type, got: typeof value },
        });
      }
    }

    if (missingParams.length > 0) {
      return new AssetError({
        code: 'asset-invalid-value',
        expected: `paramValues to contain keys: ${missingParams.join(', ')}`,
        hint: `missing required params: ${missingParams.join(', ')}`,
        detail: { missingParams },
      });
    }

    return null;
  }

  /**
   * Sprite 9-slice paramValues fail-fast validation
   * (feat-20260527-sprite-nineslice M2 / w8, plan-strategy §D-1 + AC-08).
   *
   * Fires when:
   *  - asset.kind === 'material'
   *  - first pass shader === 'forgeax::sprite'
   *  - paramValues.slices is present
   *
   * Six fail-fast branches (1:1 with w4 test):
   *   (1) any component is negative
   *   (2) slices.x + slices.z >= region.zw[0]   (X-axis overlap)
   *   (3) slices.y + slices.w >= region.zw[1]   (Y-axis overlap)
   *   (4) any component is NaN
   *   (5) any component is Infinity
   *   (6) length !== 4
   *
   * Reuses the existing 'asset-invalid-value' member of the closed
   * `AssetErrorCode` 13-member union (no new code added per
   * AGENTS.md §Error model). The `.expected` literal mirrors the AI-User
   * Charter §3 string; `.hint` inlines the offending sum + the relevant
   * `region.zw` numeral so AI users can copy-paste the prompt straight
   * back into the IDE for self-recovery (plan-strategy §R-4).
   *
   * @returns AssetError on failure, null on success.
   */
  private validateSpriteSlices(asset: MaterialAsset): AssetError | null {
    const passes = asset.passes;
    if (passes === undefined || passes.length === 0) return null;
    const firstPass = passes[0];
    if (firstPass === undefined || firstPass.shader !== 'forgeax::sprite') return null;
    const pv = (asset.paramValues ?? {}) as Record<string, unknown>;
    const slicesRaw = pv.slices;
    // Field absent — caller relies on paramSchema default [0, 0, 0, 0]; nothing to check.
    if (slicesRaw === undefined) return null;
    const expected =
      'paramValues.slices: [number, number, number, number] with 0 ≤ left + right < region.zw[0] and 0 ≤ top + bottom < region.zw[1]';
    if (!Array.isArray(slicesRaw)) {
      return new AssetError({
        code: 'asset-invalid-value',
        expected,
        hint: `paramValues.slices is not an array (got ${typeof slicesRaw}); must be a 4-tuple [left, top, right, bottom]`,
        detail: { paramName: 'slices', got: typeof slicesRaw },
      });
    }
    // (6) length check
    if (slicesRaw.length !== 4) {
      return new AssetError({
        code: 'asset-invalid-value',
        expected,
        hint: `paramValues.slices length is ${slicesRaw.length}; must be 4 ([left, top, right, bottom])`,
        detail: { paramName: 'slices', got: slicesRaw.length },
      });
    }
    const slices = slicesRaw as readonly unknown[];
    // Type check each component first.
    for (let i = 0; i < 4; i++) {
      if (typeof slices[i] !== 'number') {
        return new AssetError({
          code: 'asset-invalid-value',
          expected,
          hint: `paramValues.slices[${i}] is not a number (got ${typeof slices[i]})`,
          detail: { paramName: 'slices', got: typeof slices[i] },
        });
      }
    }
    const left = slices[0] as number;
    const top = slices[1] as number;
    const right = slices[2] as number;
    const bottom = slices[3] as number;
    // (4) NaN
    for (let i = 0; i < 4; i++) {
      if (Number.isNaN(slices[i] as number)) {
        return new AssetError({
          code: 'asset-invalid-value',
          expected,
          hint: `paramValues.slices[${i}] is NaN; all four components must be finite non-negative numbers`,
          detail: { paramName: 'slices', got: 'NaN' },
        });
      }
    }
    // (5) Infinity
    for (let i = 0; i < 4; i++) {
      if (!Number.isFinite(slices[i] as number)) {
        return new AssetError({
          code: 'asset-invalid-value',
          expected,
          hint: `paramValues.slices[${i}] is Infinity; all four components must be finite non-negative numbers`,
          detail: { paramName: 'slices', got: 'Infinity' },
        });
      }
    }
    // (1) negative — D-3 sentinel uses negative .w for tile mode but only
    // after extract; at register-time the user-supplied tuple must be all
    // non-negative (the engine encodes the sign downstream).
    for (let i = 0; i < 4; i++) {
      if ((slices[i] as number) < 0) {
        return new AssetError({
          code: 'asset-invalid-value',
          expected,
          hint: `paramValues.slices[${i}] = ${slices[i]}; all four components must be non-negative`,
          detail: { paramName: 'slices', got: slices[i] as number },
        });
      }
    }
    // (2)/(3) overlap with region. region default is [0, 0, 1, 1];
    // user override comes via paramValues.region (vec4).
    const regionRaw = pv.region;
    let regionZ = 1;
    let regionW = 1;
    if (Array.isArray(regionRaw) && regionRaw.length >= 4) {
      const rz = regionRaw[2];
      const rw = regionRaw[3];
      if (typeof rz === 'number') regionZ = rz;
      if (typeof rw === 'number') regionW = rw;
    }
    const sumX = left + right;
    if (sumX >= regionZ) {
      return new AssetError({
        code: 'asset-invalid-value',
        expected,
        hint: `received slices=[${left}, ${top}, ${right}, ${bottom}]; left + right = ${sumX} ≥ ${regionZ} (region.z)`,
        detail: { paramName: 'slices', got: sumX },
      });
    }
    const sumY = top + bottom;
    if (sumY >= regionW) {
      return new AssetError({
        code: 'asset-invalid-value',
        expected,
        hint: `received slices=[${left}, ${top}, ${right}, ${bottom}]; top + bottom = ${sumY} ≥ ${regionW} (region.w)`,
        detail: { paramName: 'slices', got: sumY },
      });
    }
    return null;
  }

  private validateParamType(_name: string, type: string, value: unknown): boolean {
    switch (type) {
      case 'f32':
      case 'i32':
      case 'u32':
        return typeof value === 'number';
      case 'vec2':
        return (
          Array.isArray(value) && value.length >= 2 && value.every((v) => typeof v === 'number')
        );
      case 'vec3':
        return (
          Array.isArray(value) && value.length >= 3 && value.every((v) => typeof v === 'number')
        );
      case 'vec4':
        return (
          Array.isArray(value) && value.length >= 4 && value.every((v) => typeof v === 'number')
        );
      case 'color':
        return (
          Array.isArray(value) &&
          (value.length === 3 || value.length === 4) &&
          value.every((v) => typeof v === 'number')
        );
      case 'texture2d':
      case 'sampler':
        // Texture/sampler params carry string GUIDs at registration time
        return typeof value === 'string';
      default:
        return false;
    }
  }

  /**
   * Register an asset and return a fresh
   * `Result<Handle<TagOf<T>, 'unmanaged'>, AssetError>`. The brand `target`
   * tag is derived from the Asset's `kind` discriminator via `AssetTagMap`
   * (charter F1 single-entry indexability). The runtime representation is
   * an auto-incrementing u32 starting at 1024 (builtins reserve 1-2).
   *
   * feat-20260526 M4: `shadingModel` field is retired in favour of
   * pass-based MaterialAsset. This generic surface covers the full
   * `Asset` closed union (mesh / texture / sampler / scene / cube-texture
   * / material).
   */
  register<T extends Asset>(asset: T): Result<Handle<TagOf<T>, 'unmanaged'>, AssetError> {
    // bug-20260523 M1 / t4: mesh vertex stride fail-fast gate at register entry.
    // Enforces canonical 12-floats-per-vertex layout (plan-strategy D-3).
    const meshValidation = validateMeshPayload(asset);
    if (meshValidation !== null) return err(meshValidation);

    // feat-20260527 M2 / w6: material validation with union paramSchema
    // semantics across all passes (plan-strategy D-2, D-5).
    if (asset.kind === 'material') {
      const matValidation = this.validateMaterialPasses(asset as MaterialAsset);
      if (matValidation !== null) return err(matValidation);
      // feat-20260527-sprite-nineslice M2 / w8: sprite-only 9-slice
      // paramValues fail-fast (6 branches; plan-strategy §D-1 + AC-08).
      const sliceValidation = this.validateSpriteSlices(asset as MaterialAsset);
      if (sliceValidation !== null) return err(sliceValidation);
      // feat-20260527-sprite-nineslice M4 / w18 (D-9): tile-mode sampler soft-
      // warn. Detection-only, never throws (AC-08 closed at 6 branches; never
      // extends AssetErrorCode). The 9-slice tile path needs
      // sampler.addressMode='repeat' for the visual to actually wrap; clamp-
      // to-edge silently degrades to a stretched centre tile, which is the
      // exact "silent failure" charter P3 forbids. Counter bumps so AI users
      // see a concrete signal in `renderer.metrics.snapshot()` (machine-
      // readable) without console.warn flooding.
      this.detectTileNeedsRepeatSampler(asset as MaterialAsset);
    }

    let stored: Asset = asset;
    if (asset.kind === 'mesh') {
      stored = withMeshAabb(asset as TypesMeshAsset);
    }

    const id = this.nextHandle++;
    this.assets.set(id, stored);
    return ok(toUnmanaged<TagOf<T>>(id));
  }

  /**
   * feat-20260527-sprite-nineslice M4 / w18 (D-9): register-time soft-warn
   * for sliceMode=1 (tile) bound to a sampler whose addressMode is not
   * 'repeat'. Bumps `nineslice.tile-needs-repeat-sampler` once per offending
   * register call. Never throws — the counter is the sole AI-user-facing
   * signal (charter P3 machine-readable; AC-08 closed at 6 fail-fast
   * branches, never extends AssetErrorCode).
   *
   * Resolution chain:
   *   1. Material's first pass.shader === 'forgeax::sprite' AND
   *      paramValues.sliceMode === 1 (tile mode).
   *   2. paramValues.sampler resolves to a registered SamplerAsset POD.
   *   3. SamplerAsset.addressModeU !== 'repeat' OR addressModeV !== 'repeat'.
   *
   * Any link broken (no metrics wired, sampler unresolvable, addressMode
   * already 'repeat') is a no-op. The reverse case
   * (sliceMode=1 + sampler.addressMode='repeat') keeps the counter at 0.
   */
  private detectTileNeedsRepeatSampler(asset: MaterialAsset): void {
    if (this.metrics === null) return;
    const passes = asset.passes;
    if (passes === undefined || passes.length === 0) return;
    const firstPass = passes[0];
    if (firstPass === undefined || firstPass.shader !== 'forgeax::sprite') return;
    const pv = (asset.paramValues ?? {}) as Record<string, unknown>;
    const sliceMode = typeof pv.sliceMode === 'number' ? pv.sliceMode : 0;
    if (sliceMode !== 1) return;
    const samplerHandleRaw = typeof pv.sampler === 'number' ? pv.sampler : undefined;
    if (samplerHandleRaw === undefined) return;
    const samplerAsset = this.assets.get(samplerHandleRaw);
    if (samplerAsset === undefined || samplerAsset.kind !== 'sampler') return;
    const u = samplerAsset.addressModeU;
    const v = samplerAsset.addressModeV;
    // 'repeat' on BOTH U and V is required for a 2D tile to wrap. Either side
    // missing or differing degrades visually to a clamp-stretch centre tile.
    if (u !== 'repeat' || v !== 'repeat') {
      this.metrics.increment('nineslice.tile-needs-repeat-sampler');
    }
  }

  /**
   * Look up an asset by handle. Returns `Result.err(asset-not-found)` on
   * miss (charter proposition 4 explicit failure; switch on
   * `res.error.code` to recover).
   */
  get<T extends Asset>(handle: Handle<TagOf<T>, 'unmanaged'>): Result<T, AssetError> {
    const id = unwrapHandle(handle);
    const asset = this.assets.get(id);
    if (asset === undefined) {
      return err(
        new AssetError({
          code: 'asset-not-found',
          expected: `handle id ${id} present in AssetRegistry`,
          hint: ASSET_ERROR_HINTS['asset-not-found'],
        }),
      );
    }
    return ok(asset as T);
  }

  /**
   * Read-through parent-chain walk returning the walk transient directly.
   *
   * **Internal-only (transient, non-aggregate, D-6).** Only the extract
   * stage hot path consumes this to avoid N `paramValueOf` calls per
   * entity. The returned `{passes, paramValues}` is a function-local
   * transient — never stored, never exported as a named type (AC-07, S-5).
   *
   * Zero-cache (AC-04): every call full-walks. Cycle detection (W-1):
   * `AssetError` with `'material-circular-inheritance'`. Empty passes
   * (AC-09, D-3): `MaterialResolvedEmptyPassesError`.
   *
   * @returns `Result` with walk transient, or error on cycle / empty passes.
   * @internal
   */
  _materialWalk(
    handle: Handle<'MaterialAsset', 'unmanaged'>,
  ): Result<
    { passes: MaterialPassDescriptor[]; paramValues: Record<string, unknown> },
    AssetError | MaterialResolvedEmptyPassesError
  > {
    return this.walkMaterialPasses(unwrapHandle(handle));
  }

  /**
   * Read-through resolve: walk the MaterialAsset parent chain and return the
   * inherited passes list (W-1~W-7 semantics from research Finding 3).
   *
   * Zero-cache (AC-04): every call performs a full walk — no memoization.
   * Cycle detection (W-1): returns `AssetError` with code
   * `'material-circular-inheritance'`. Empty passes (AC-09, D-3): fires
   * `MaterialResolvedEmptyPassesError` with `.detail.reason` discriminating
   * `'missing-parent'` vs `'no-pass-in-chain'`.
   *
   * @returns `Result` with inherited passes, or `AssetError` on cycle /
   *   `MaterialResolvedEmptyPassesError` on empty passes.
   */
  passesOf(
    handle: Handle<'MaterialAsset', 'unmanaged'>,
  ): Result<readonly MaterialPassDescriptor[], AssetError | MaterialResolvedEmptyPassesError> {
    const id = unwrapHandle(handle);
    const walkResult = this.walkMaterialPasses(id);
    if (!walkResult.ok) return walkResult;
    return ok(walkResult.value.passes);
  }

  /**
   * Read-through single-key param value lookup across the material's parent
   * chain (W-4 shallow-merge semantics).
   *
   * Zero-cache (AC-04): every call performs a full walk. Key not found in
   * any chain member returns `Ok(undefined)` (value semantics, not error).
   *
   * @returns `Result` with the merged param value or `undefined` if key absent.
   */
  paramValueOf(
    handle: Handle<'MaterialAsset', 'unmanaged'>,
    key: string,
  ): Result<unknown, AssetError | MaterialResolvedEmptyPassesError> {
    const id = unwrapHandle(handle);
    const walkResult = this.walkMaterialPasses(id);
    if (!walkResult.ok) return walkResult;
    return ok(walkResult.value.paramValues[key]);
  }

  /**
   * Internal parent-chain walk (shared by passesOf / paramValueOf).
   * Produces a function-local transient `{passes, paramValues}` that is
   * immediately destructured at the public method boundary (AC-07 / S-5:
   * transient only, never exported as a named aggregate type).
   *
   * D-3: missing-parent (W-2) is tightened — the walk tracks
   * `missingParentHandle` and, if final passes is empty, the error fires
   * with `.detail.reason = 'missing-parent'` or `'no-pass-in-chain'`.
   */
  private walkMaterialPasses(
    handleId: number,
  ): Result<
    { passes: MaterialPassDescriptor[]; paramValues: Record<string, unknown> },
    AssetError | MaterialResolvedEmptyPassesError
  > {
    const visited = new Set<number>();
    const chainNames: string[] = [];
    let missingParentHandle: number | undefined;

    function walk(
      id: number,
      assets: Map<number, Asset>,
    ): { passes: MaterialPassDescriptor[]; paramValues: Record<string, unknown> } | null {
      if (visited.has(id)) {
        chainNames.push(String(id));
        return null;
      }
      visited.add(id);
      chainNames.push(String(id));

      const asset = assets.get(id);
      if (!asset) {
        missingParentHandle = id;
        return { passes: [], paramValues: {} };
      }

      const material = asset as MaterialAsset;

      let parentPasses: MaterialPassDescriptor[] = [];
      let parentParamValues: Record<string, unknown> = {};

      if (material.parent !== undefined) {
        const parentId = unwrapHandle(material.parent as Handle<'MaterialAsset', 'unmanaged'>);
        const parentResult = walk(parentId, assets);
        if (parentResult === null) return null;
        parentPasses = parentResult.passes;
        parentParamValues = parentResult.paramValues;
      }

      // W-4: child paramValues shallow-merge over parent
      const mergedParams: Record<string, unknown> = { ...parentParamValues };
      if (material.paramValues) {
        for (const [k, v] of Object.entries(material.paramValues)) {
          mergedParams[k] = v;
        }
      }

      // W-5: no passes — full inheritance from parent
      if (!material.passes || material.passes.length === 0) {
        return { passes: parentPasses, paramValues: mergedParams };
      }

      // W-6: child passes override parent by name, new names append
      const parentByName = new Map<string, MaterialPassDescriptor>();
      for (const p of parentPasses) {
        parentByName.set(p.name, p);
      }
      const mergedPasses: MaterialPassDescriptor[] = [];
      const seenNames = new Set<string>();
      for (const cp of material.passes) {
        seenNames.add(cp.name);
        mergedPasses.push(cp);
      }
      for (const pp of parentPasses) {
        if (!seenNames.has(pp.name)) {
          mergedPasses.push(pp);
        }
      }

      return { passes: mergedPasses, paramValues: mergedParams };
    }

    const result = walk(handleId, this.assets);
    if (result === null) {
      // W-7: cycle error construction
      return err(
        new AssetError({
          code: 'material-circular-inheritance',
          expected: 'material parent chain forms no cycle',
          hint: ASSET_ERROR_HINTS['material-circular-inheritance'],
          detail: { cycle: chainNames.join(' -> ') },
        }),
      );
    }

    // D-3: empty passes — fail-fast with reason discrimination
    if (result.passes.length === 0) {
      const reason = missingParentHandle !== undefined ? 'missing-parent' : 'no-pass-in-chain';
      const htg = this.handleToGuid.get(handleId);
      const materialGuid = htg !== undefined ? AssetGuid.format(htg) : `handle-${handleId}`;
      return err(new MaterialResolvedEmptyPassesError(materialGuid, reason, missingParentHandle));
    }

    return ok(result);
  }

  /**
   * Register an asset with a GUID and return a fresh
   * `Handle<TagOf<T>, 'unmanaged'>`. Throws
   * `AssetError{code:'asset-not-found'}` if the GUID is already registered
   * (collision guard; pack-guid-collision will be a distinct code in M3;
   * for now asset-not-found is the closest available code).
   *
   * The brand is phantom (compile-time only); the runtime value is an
   * auto-incrementing u32 starting at 1024 (builtins reserve 1-2).
   */
  registerWithGuid<T extends Asset>(guid: AssetGuid, asset: T): Handle<TagOf<T>, 'unmanaged'> {
    const key = AssetGuid.format(guid);
    if (this.guidToHandle.has(key)) {
      throw new AssetError({
        code: 'asset-not-found',
        expected: `GUID ${key} not already registered (collision)`,
        hint: ASSET_ERROR_HINTS['asset-not-found'],
      });
    }
    // bug-20260523 M3 / t9: registerWithGuid is the entrance point for
    // loadByGuid (via loadByGuidProd -> parseAssetPayload -> registerWithGuid).
    // The mesh vertex stride gate MUST fire here so pack-payload non-12F
    // meshes are rejected before the asset lands in the registry map
    // (plan-strategy D-2: registerWithGuid covered by the mesh gate).
    const meshValidation = validateMeshPayload(asset);
    if (meshValidation !== null) {
      throw meshValidation;
    }
    // feat-20260527 M2 / w6: material validation (plan-strategy D-2).
    if (asset.kind === 'material') {
      const matValidation = this.validateMaterialPasses(asset as MaterialAsset);
      if (matValidation !== null) throw matValidation;
      // feat-20260527-sprite-nineslice M2 / w8: sprite 9-slice fail-fast.
      const sliceValidation = this.validateSpriteSlices(asset as MaterialAsset);
      if (sliceValidation !== null) throw sliceValidation;
      // feat-20260527-sprite-nineslice M4 / w18 (D-9): tile-mode sampler
      // soft-warn (counter only, no throw — see detectTileNeedsRepeatSampler).
      this.detectTileNeedsRepeatSampler(asset as MaterialAsset);
    }
    let stored: Asset = asset;
    if (asset.kind === 'mesh') {
      stored = withMeshAabb(asset as TypesMeshAsset);
    }
    const id = this.nextHandle++;
    this.assets.set(id, stored);
    const handle = toUnmanaged<TagOf<T>>(id);
    this.guidToHandle.set(key, handle);
    this.handleToGuid.set(id, guid);
    return handle;
  }

  /**
   * Resolve a GUID to a `Handle<TagOf<T>, 'unmanaged'>`. Returns
   * `Result.err(asset-not-found)` when the GUID has not been registered.
   */
  resolveGuid<T extends Asset>(guid: AssetGuid): Result<Handle<TagOf<T>, 'unmanaged'>, AssetError> {
    const key = AssetGuid.format(guid);
    const handle = this.guidToHandle.get(key);
    if (handle === undefined) {
      return err(
        new AssetError({
          code: 'asset-not-found',
          expected: `GUID ${key} registered in AssetRegistry`,
          hint: ASSET_ERROR_HINTS['asset-not-found'],
        }),
      );
    }
    return ok(handle as Handle<TagOf<T>, 'unmanaged'>);
  }

  /**
   * Return the `AssetGuid` associated with a handle, or `undefined` if the
   * handle was not registered via `registerWithGuid`.
   */
  guidOf(handle: Handle<string, 'unmanaged'>): AssetGuid | undefined {
    return this.handleToGuid.get(unwrapHandle(handle));
  }

  /**
   * feat-20260613-material-paramschema-driven-binding M4 / w23 (D-5 graceful):
   * Return the texture-field name set for the given material-shader id,
   * derived from the registered shader's paramSchema via `derive(paramSchema)
   * .textureFieldNames`. Returns `undefined` when the shader is not yet
   * registered (cross-worktree shader-late-register, plan R-4).
   *
   * Used by `extractFrame` to know which paramValues fields the shader
   * declares as texture handles; the extract layer validates handle-vs-
   * scalar typing and drops misclassified slots so the record stage's
   * MISSING_TEXTURE_HANDLE fallback can take over (white default texture)
   * rather than letting a stray handle reach `device.createBindGroup`.
   */
  materialShaderTextureFieldNames(shaderId: string): ReadonlySet<string> | undefined {
    const lookup = this.shaderRegistry.lookupMaterialShader(shaderId);
    if (!lookup.ok) return undefined;
    return derive(lookup.value.paramSchema).textureFieldNames;
  }

  /**
   * feat-20260613-material-paramschema-driven-binding M4 / w23 (D-5 graceful):
   * Return the kind brand for the asset registered under `handle`, or
   * `undefined` when the handle is not in this registry. Lets the extract
   * layer validate that a paramValues int that the loader resolved to a
   * handle actually points at a texture asset (vs a misclassified scalar
   * from the shader-late-register fallback path).
   */
  kindOf(handle: Handle<string, 'unmanaged'>): string | undefined {
    const asset = this.assets.get(unwrapHandle(handle));
    if (asset === undefined) return undefined;
    return (asset as { kind?: unknown }).kind as string | undefined;
  }

  /**
   * Load an asset and all its transitively referenced sub-assets by GUID;
   * returns `ok(handle)` only when the asset and every sub-asset are in the
   * registry.
   *
   * **Post-condition:** `ok(handle)` is returned ONLY when the asset AND every
   * transitively referenced sub-asset (per `collectRefs(asset)` dispatch on
   * `asset.kind`) are present in this registry. The implementation walks
   * `collectRefs(asset)` and recursively calls `loadByGuid` on each ref before
   * registering the top-level asset.
   *
   * Two paths:
   * - **Dev / fallback** (no `configurePackIndex` call): synchronous Map lookup
   *   wrapped in `Promise.resolve`. Returns `Err(asset-not-found)` if not in
   *   registry.
   * - **Prod** (after `configurePackIndex(url)`): fetches `pack-index.json`
   *   on the first call (cached as a `Map<guid, {relativeUrl, kind}>`), then
   *   fetches the individual resource URL and parses the asset payload, then
   *   calls `registerWithGuid` and returns the `Handle`.
   *
   * Error union: `AssetError | PackError | ImageError | RhiError` (closed -- no
   * new codes were introduced by the recursive walk; every code is pre-existing).
   *
   * An in-flight `Map` (D-5) deduplicates concurrent calls for the same GUID and
   * prevents stack overflow on cycles (A->B->A).
   *
   * **Breaking-change classification:** this is a semantic strengthening, not a
   * shape change. Pre-existing consumers that pre-register sub-assets via
   * `registerWithGuid` are protected by the `guidToHandle` fast-path: the
   * recursive walk hits cache on every node and incurs zero additional fetch.
   *
   * @example
   * ```ts
   * const res = await engine.assets.loadByGuid<SceneAsset>(sceneGuid);
   * if (!res.ok) {
   *   switch (res.error.code) {
   *     case 'asset-not-found':
   *       // top GUID or any sub-asset GUID is missing from the catalog
   *       break;
   *     case 'asset-fetch-failed':
   *       // network / CORS
   *       break;
   *     case 'asset-parse-failed':
   *       // payload malformed
   *       break;
   *     // ... AssetErrorCode | PackErrorCode | ImageErrorCode | RhiErrorCode exhaustive
   *   }
   *   return;
   * }
   * ```
   */
  async loadByGuid<T extends Asset>(
    guid: AssetGuid,
    parentContext?: {
      sceneEntityId?: number;
      componentField?: string;
    },
  ): Promise<Result<Handle<TagOf<T>, 'unmanaged'>, AssetError | ImageError | RhiError>> {
    const guidKey = AssetGuid.format(guid);

    // Fast path: already in the in-memory registry (covers dev + prod cached repeat calls).
    const existing = this.guidToHandle.get(guidKey);
    if (existing !== undefined) {
      return ok(existing as Handle<TagOf<T>, 'unmanaged'>);
    }

    // In-flight dedup (D-5 / B-10): if another call is already loading this
    // GUID, return that same Promise — covers (a) concurrent same-GUID calls
    // and (b) cycle A→B→A termination (B reaches A's in-flight entry).
    const inFlightPromise = this.inFlight.get(guidKey);
    if (inFlightPromise !== undefined) {
      return inFlightPromise as Promise<
        Result<Handle<TagOf<T>, 'unmanaged'>, AssetError | ImageError | RhiError>
      >;
    }

    // Prod fetch path: only enabled when packIndexUrl is configured.
    if (this.packIndexUrl !== undefined && typeof globalThis.fetch === 'function') {
      const promise = this.loadByGuidProd<T>(guid, guidKey, parentContext);
      this.inFlight.set(guidKey, promise);
      try {
        const result = await promise;
        return result;
      } finally {
        this.inFlight.delete(guidKey);
      }
    }

    // Dev / fallback: synchronous Map lookup (no network).
    return Promise.resolve(this.resolveGuid<T>(guid));
  }

  /**
   * feat-20260603-asset-import-loader-injection M1 / w6: load an
   * upstream-branch kind (texture / font) straight from its catalog entry
   * through the injected async loader, then register the produced POD. Replaces
   * the bespoke `loadTextureFromEntry` / `loadFontFromEntry` methods; the decode
   * / glyph-parse logic moved verbatim into the loader bodies (D-2 — loader is
   * pure of `registerWithGuid`, which stays here).
   */
  private async loadFromUpstreamEntry<T extends Asset>(
    guidKey: string,
    entry: {
      relativeUrl: string;
      kind: string;
      metadata?: ImageMetadata | CubeTextureMetadata | undefined;
    },
  ): Promise<Result<Handle<TagOf<T>, 'unmanaged'>, AssetError | ImageError | RhiError>> {
    const loader = this.loaders.get(entry.kind);
    if (loader === undefined) {
      return err(
        new AssetError({
          code: 'loader-not-registered',
          expected: `a loader registered for kind '${entry.kind}'`,
          hint: ASSET_ERROR_HINTS['loader-not-registered'],
          detail: { kind: entry.kind, registeredKinds: this.loaders.registeredKinds() },
        }),
      );
    }
    const out = loader.load({ ...entry, guidKey }, undefined, this.makeLoadContext());
    // Upstream-branch loaders are async (Promise<LoaderAsyncResult>).
    const result = (await out) as LoaderAsyncResult;
    if (!result.ok) {
      return err(result.error as AssetError | ImageError | RhiError);
    }
    const guid = AssetGuid.parse(guidKey);
    if (!guid.ok) {
      return err(
        new AssetError({
          code: 'asset-parse-failed',
          expected: `valid GUID ${guidKey}`,
          hint: ASSET_ERROR_HINTS['asset-parse-failed'],
        }),
      );
    }
    try {
      return ok(this.registerWithGuid(guid.value, result.value) as Handle<TagOf<T>, 'unmanaged'>);
    } catch (e: unknown) {
      if (
        typeof e === 'object' &&
        e !== null &&
        'code' in e &&
        typeof (e as Record<string, unknown>).code === 'string'
      ) {
        return err(e as AssetError);
      }
      throw e;
    }
  }

  /**
   * Internal: prod fetch path for `loadByGuid`.
   * Fetches pack-index.json (cached), then fetches the pack file, parses the
   * asset payload, and registers it.
   */
  private async loadByGuidProd<T extends Asset>(
    guid: AssetGuid,
    guidKey: string,
    parentContext?: {
      sceneEntityId?: number;
      componentField?: string;
    },
  ): Promise<Result<Handle<TagOf<T>, 'unmanaged'>, AssetError | ImageError | RhiError>> {
    // feat-20260603-asset-import-loader-injection M4 / w31 (AC-19 lazy iron law):
    // wrap the DDC fetch + load path so a DDC miss can be routed through the
    // injected ImportTransport (studio form) or fail-fast with
    // `asset-not-imported` (shipped form, AC-22). The load path after a
    // successful DDC resolve is identical in both forms -- zero branches on
    // `this.importTransport` (AC-23 key invariant).
    //
    // A DDC miss is: (a) the GUID is absent from the catalog, OR (b) the
    // `.pack.json` fetch returns `asset-not-found` / `asset-fetch-failed`.
    // In case (a) the transport is probed first (the pack-index may have been
    // built before the asset was imported); in case (b) the transport is the
    // only fallback (the pack file is genuinely missing).

    const entry = await this.resolveCatalogEntry(guidKey);
    if (entry !== undefined) {
      // Catalog hit: try the DDC load path.
      const result = await this.ddcLoad<T>(guid, guidKey, entry, parentContext);
      if (result.ok) return result;
      // DDC miss: only route through transport when the error indicates a
      // missing pack file (not a parse / validation failure inside the pack) or
      // an unimported texture source (feat-20260604 M2 / D-1: import-on-demand).
      // `texture-source-not-imported` is an AssetError, so it passes the
      // `instanceof AssetError` guard naturally. `image-decode-failed` is an
      // ImageError (a genuinely corrupt imported .bin) -- it fails the guard and
      // is therefore never transport-eligible (Risk-1), so a real decode
      // failure is never silently lazy-imported.
      const ddcError = result.error;
      const transportEligible =
        ddcError instanceof AssetError &&
        (ddcError.code === 'asset-not-found' ||
          ddcError.code === 'asset-fetch-failed' ||
          ddcError.code === 'texture-source-not-imported');
      if (transportEligible) {
        return this.transportOrFail<T>(guid, guidKey, ddcError.code);
      }
      return result;
    }

    // Catalog miss: the GUID is not in the pack-index. In the studio form the
    // import transport can lazily create the missing DDC.
    return this.transportOrFail<T>(guid, guidKey, 'asset-not-found');
  }

  /**
   * Resolve the catalog entry for a GUID, lazily fetching the pack-index on
   * first call. Returns `undefined` when the GUID is absent from the catalog.
   */
  private async resolveCatalogEntry(guidKey: string): Promise<
    | {
        relativeUrl: string;
        kind: string;
        metadata?: ImageMetadata | CubeTextureMetadata | undefined;
      }
    | undefined
  > {
    if (this.packIndexCache === undefined) {
      const catalogResult = await this.fetchPackIndex();
      if (!catalogResult.ok) {
        this.packIndexCache = new Map();
        return undefined;
      }
      this.packIndexCache = catalogResult.value;
    }
    return this.packIndexCache.get(guidKey.toLowerCase());
  }

  /**
   * Load an asset through the DDC (catalog entry -> fetch pack -> loader.load
   * -> register). Returns `Err(asset-not-found)` or `Err(asset-fetch-failed)`
   * on DDC miss (the caller then decides whether to route through the
   * import transport).
   *
   * This path is IDENTICAL in studio and shipped forms -- the only difference
   * between the two is whether `this.importTransport` exists when the caller
   * falls back to `transportOrFail` (AC-23 key invariant).
   */
  private async ddcLoad<T extends Asset>(
    guid: AssetGuid,
    guidKey: string,
    entry: {
      relativeUrl: string;
      kind: string;
      metadata?: ImageMetadata | CubeTextureMetadata | undefined;
    },
    parentContext?: {
      sceneEntityId?: number;
      componentField?: string;
    },
  ): Promise<Result<Handle<TagOf<T>, 'unmanaged'>, AssetError | ImageError | RhiError>> {
    // feat-20260603-asset-import-loader-injection M1 / w6: the texture / font
    // "upstream-branch" kinds (research Finding 2) are loaded straight from the
    // catalog entry (no `.pack.json` payload detour) through their injected
    // async loaders. Routing is data-driven off the loader set
    // (`UPSTREAM_ENTRY_KINDS`), not a hardcoded `if (entry.kind === 'texture')`
    // chain (AC-01). The loader produces the POD; `registerWithGuid` stays here
    // (D-2).
    if (UPSTREAM_ENTRY_KINDS.has(entry.kind)) {
      return this.loadFromUpstreamEntry<T>(guidKey, entry);
    }

    // bug-20260610: when the asset is a material, its paramValues handle
    // fields (e.g. baseColorTexture) are stored on disk as refs[] indices.
    // The materialLoader resolves these via `LoadContext.resolveRefSync` -
    // which needs the texture sub-assets ALREADY registered in this registry.
    // For non-material kinds, fetch+parse in one step (legacy path); for
    // material we fetch the raw entry, recursively load every refs[] GUID
    // first, then parse + register. The cycle-safety register-before-recurse
    // invariant for the parent still holds (we register the material AFTER
    // texture preload but no consumer of the material is awakened until the
    // overall loadByGuid resolves).
    let packResult: Result<Asset, AssetError>;
    if (entry.kind === 'mesh' && entry.relativeUrl.endsWith('.bin')) {
      // bug-20260610 Fix A: mesh sub-assets carry their vertices / indices in
      // a sibling `<guid>.bin` produced by `packMeshBin` (build-time, in
      // @forgeax/engine-import), not as inline JSON arrays. The catalog row's
      // relativeUrl points straight at the .bin (D-3); we read it via
      // `LoadContext.fetchBinary`, decode through `unpackMeshBin`, and feed a
      // hydrated synthetic payload through the meshLoader (no .pack.json
      // round-trip for mesh -- saves the 80 MB JSON parse on Sponza). The
      // legacy inline-array path (CON-7) still flows through the regular
      // `fetchPackFile` -> meshLoader branch below when the catalog row
      // points at a `.pack.json` carrying number-array vertices (older
      // fixtures and direct-register tests).
      const ctx = this.makeLoadContext();
      const binFetch = await ctx.fetchBinary(entry.relativeUrl);
      if (!binFetch.ok) {
        return err(binFetch.error) as Result<Handle<TagOf<T>, 'unmanaged'>, AssetError>;
      }
      const unpacked = unpackMeshBin(binFetch.value);
      if (unpacked === undefined) {
        return err(
          new AssetError({
            code: 'asset-parse-failed',
            expected: `decodable mesh-bin payload for GUID ${guidKey}`,
            hint: ASSET_ERROR_HINTS['asset-parse-failed'],
          }),
        );
      }
      // feat-20260612 M2 fixup: pass `indices` through verbatim (including the
      // undefined case for mesh-bins with `ilen=0`, e.g. Fox.glb non-indexed
      // primitives). The previous `?? new Uint16Array(0)` synthesised an
      // empty typed array; meshLoader accepted it but downstream
      // gpu-resource-store treated `indices !== undefined` as "has indices",
      // allocated a 0-byte IBO, and the first frame's
      // `setIndexBuffer(buffer.slice(0..0), ...)` panicked wgpu's
      // `BufferSlice` "buffer slices can not be empty" assertion. meshLoader
      // now accepts undefined and returns a MeshAsset whose `indices` field
      // is omitted, taking the non-indexed `pass.draw` path in record stage.
      const synthIndices: Uint16Array | Uint32Array | undefined = unpacked.indices;
      // bug-20260610: per-stream typed arrays for position / normal / uv /
      // tangent are intentionally absent from the .bin payload (they
      // duplicate the interleaved bytes already in `vertices`); the
      // meshLoader's `payload.attributes ?? {}` fallback handles that.
      // feat-20260611 (w17-b): skinIndex / skinWeight are an exception --
      // they ride alongside the interleaved buffer because the runtime
      // pbr-skin VBO layout reads `attributes.skinIndex` directly via
      // `deriveVertexBufferLayout`. When present in the .bin, hydrate them
      // back into `attributes`; absent (legacy / unskinned) -> empty object.
      const synthAttributes: Record<string, unknown> = {};
      if (unpacked.skinIndex !== undefined) synthAttributes.skinIndex = unpacked.skinIndex;
      if (unpacked.skinWeight !== undefined) synthAttributes.skinWeight = unpacked.skinWeight;
      const synthPayload: Record<string, unknown> = {
        vertices: unpacked.vertices,
        ...(synthIndices !== undefined ? { indices: synthIndices } : {}),
        attributes: synthAttributes,
        ...(unpacked.submeshes !== undefined ? { submeshes: unpacked.submeshes } : {}),
        ...(unpacked.aabb !== undefined ? { aabb: unpacked.aabb } : {}),
      };
      const parsed = this.parseAssetPayload('mesh', synthPayload);
      if (parsed === undefined) {
        return err(
          new AssetError({
            code: 'asset-parse-failed',
            expected: `parseable mesh payload for GUID ${guidKey}`,
            hint: ASSET_ERROR_HINTS['asset-parse-failed'],
          }),
        );
      }
      packResult = ok(parsed);
    } else if (entry.kind === 'material') {
      // Two-phase: fetch raw entry, preload only paramValues-texture refs[]
      // (NOT the parent slot — the parent path below carries a precise
      // breadcrumb hint that downstream tests assert on), then parseAssetPayload.
      const rawResult = await this.fetchPackEntry(entry.relativeUrl, guidKey);
      if (!rawResult.ok) {
        return rawResult as unknown as Result<Handle<TagOf<T>, 'unmanaged'>, AssetError>;
      }
      const refsRaw = rawResult.value.refs ?? [];
      const matPayload = rawResult.value.payload as Record<string, unknown>;
      const matParamValues = (matPayload.paramValues as Record<string, unknown> | undefined) ?? {};
      // feat-20260613-material-paramschema-driven-binding M4 / w22 (D-5 graceful):
      // the texture-field allowlist is now derived from the registered shader's
      // paramSchema (mirrors materialLoader.load above). When the shader is
      // not yet registered, fall back to "every int paramValue in
      // [0, refs.length)" — pre-loading a non-texture sub-asset here is
      // harmless because loadByGuid is idempotent (the registry caches by GUID).
      const passesFromPayload = matPayload.passes;
      const shaderTextureFields = collectShaderTextureFieldNames(
        passesFromPayload,
        this.makeLoadContext(),
      );
      const candidateFields =
        shaderTextureFields !== undefined ? shaderTextureFields : Object.keys(matParamValues);
      const textureRefIndices = new Set<number>();
      for (const fieldName of candidateFields) {
        const v = matParamValues[fieldName];
        if (typeof v !== 'number' || !Number.isInteger(v)) continue;
        if (v < 0 || v >= refsRaw.length) continue;
        textureRefIndices.add(v);
      }
      for (const idx of textureRefIndices) {
        if (idx < 0 || idx >= refsRaw.length) continue;
        const refGuidStr = refsRaw[idx];
        if (typeof refGuidStr !== 'string') continue;
        const refParse = AssetGuid.parse(refGuidStr);
        if (!refParse.ok) continue;
        const refLoaded = await this.loadByGuid(refParse.value);
        if (!refLoaded.ok) {
          // Texture sub-asset failed to load — surface so the material
          // registration sees a precise error rather than a silent grey.
          return refLoaded as unknown as Result<Handle<TagOf<T>, 'unmanaged'>, AssetError>;
        }
      }
      const parsed = this.parseAssetPayload(
        rawResult.value.kind,
        rawResult.value.payload,
        rawResult.value.refs,
      );
      if (parsed === undefined) {
        return err(
          new AssetError({
            code: 'asset-parse-failed',
            expected: `parseable material payload for GUID ${guidKey}`,
            hint: ASSET_ERROR_HINTS['asset-parse-failed'],
          }),
        );
      }
      packResult = ok(parsed);
    } else {
      packResult = await this.fetchPackFile(entry.relativeUrl, guidKey, entry.kind);
    }
    if (!packResult.ok) {
      return packResult as Result<Handle<TagOf<T>, 'unmanaged'>, AssetError>;
    }

    const asset = packResult.value;

    // feat-20260528-pack-material-parent-inheritance M2 / w5: parent
    // recursive preload (D-2). When the parsed asset is a material with a
    // `parentGuid` string, load the parent first so its Handle can be injected
    // before `registerWithGuid`.
    if (
      asset.kind === 'material' &&
      'parentGuid' in (asset as unknown as Record<string, unknown>) &&
      typeof (asset as unknown as Record<string, unknown>).parentGuid === 'string'
    ) {
      const parentGuidStr = (asset as unknown as MaterialAsset & { parentGuid: string }).parentGuid;
      const parentGuid = AssetGuid.parse(parentGuidStr);
      if (!parentGuid.ok) {
        return err(
          new AssetError({
            code: 'asset-parse-failed',
            expected: `valid parent GUID for child ${guidKey}`,
            hint: `parent GUID '${parentGuidStr}' is not a valid UUID format`,
          }),
        );
      }
      const parentResult = await this.loadByGuid<MaterialAsset>(parentGuid.value);
      if (!parentResult.ok) {
        const parentErr = parentResult.error;
        const code: AssetErrorCode =
          parentErr instanceof AssetError ? parentErr.code : 'asset-parse-failed';
        return err(
          new AssetError({
            code,
            expected: parentErr.expected,
            hint: `loading parent material ${parentGuidStr} for child ${guidKey}: ${
              parentErr.hint ?? ''
            }`,
            ...(parentErr.detail !== undefined
              ? { detail: parentErr.detail as Readonly<AssetErrorDetail> }
              : {}),
          }),
        );
      }
      const parentHandle = parentResult.value;
      const parentAsset = this.assets.get(
        unwrapHandle(parentHandle as Handle<string, 'unmanaged'>),
      );
      if (parentAsset === undefined || parentAsset.kind !== 'material') {
        return err(
          new AssetError({
            code: 'asset-parse-failed',
            expected: `parent GUID ${parentGuidStr} to reference a MaterialAsset`,
            hint: `loading parent material ${parentGuidStr} for child ${guidKey}: referenced asset is ${parentAsset?.kind ?? 'unknown'}, not 'material'`,
          }),
        );
      }
      const matAsset = asset as unknown as MaterialAsset & { parentGuid?: string };
      const passes = matAsset.passes;
      const paramValues = matAsset.paramValues;
      const resolvedAsset: MaterialAsset = {
        kind: 'material',
        ...(passes !== undefined ? { passes } : {}),
        ...(paramValues !== undefined ? { paramValues } : {}),
        parent: parentHandle as Handle<'MaterialAsset', 'unmanaged'>,
      };
      return this.registerParsedAsset<T>(guid, resolvedAsset, guidKey);
    }

    // tweak-20260609 M1: register the asset BEFORE recursing into its
    // sub-assets. This way, when a cycle (A→B→A) reaches back to A during
    // B's recursion, A is already in `guidToHandle` (fast-path hit) and the
    // inFlight Promise for A can be fulfilled. The inFlight entry in
    // `loadByGuid` is the second line of defense — it catches concurrent
    // same-GUID calls before the asset is registered.
    const registerResult = this.registerParsedAsset<T>(guid, asset, guidKey);
    if (!registerResult.ok) return registerResult;
    const registeredHandle = registerResult.value;

    const refs = collectRefs(asset);
    if (refs.length > 0) {
      const subResults = await Promise.all(
        refs.map((ref) => {
          const refGuidKey = AssetGuid.format(ref);
          const childContext:
            | {
                sceneEntityId?: number;
                componentField?: string;
              }
            | undefined =
            asset.kind === 'scene' ? this.buildSceneChildContext(asset, refGuidKey) : undefined;
          return this.loadByGuid(ref, childContext ?? parentContext).then((r) => ({
            guidKey: refGuidKey,
            result: r,
            childContext,
          }));
        }),
      );

      // If any sub-asset load failed, propagate the first error enriched with
      // parent breadcrumb.
      for (const {
        guidKey: subGuidKey,
        result: subResult,
        childContext: subChildContext,
      } of subResults) {
        if (!subResult.ok) {
          const subErr = subResult.error;
          const breadcrumb = this.buildBreadcrumbHint(
            guidKey,
            asset.kind,
            subGuidKey,
            subChildContext ?? parentContext,
          );
          const code: AssetErrorCode =
            subErr instanceof AssetError ? subErr.code : 'asset-fetch-failed';
          return err(
            new AssetError({
              code,
              expected: subErr.expected,
              hint: `${breadcrumb} / ${subErr.hint ?? ''}`,
              ...(subErr instanceof AssetError && subErr.detail !== undefined
                ? { detail: subErr.detail as Readonly<AssetErrorDetail> }
                : {}),
            }),
          );
        }
      }
    }

    return ok(registeredHandle as Handle<TagOf<T>, 'unmanaged'>);
  }

  /**
   * tweak-20260609 M1 helper: build the per-sub-ref parent context for a
   * SceneAsset child. Walks the scene's entities to find which entity's
   * component.field references the given sub-asset GUID, producing a
   * `parentContext` with `sceneEntityId` and `componentField` for precise
   * error breadcrumbs (D-7 / B-8).
   */
  private buildSceneChildContext(
    scene: Asset & { kind: 'scene' },
    subGuidKey: string,
  ):
    | {
        sceneEntityId?: number;
        componentField?: string;
      }
    | undefined {
    const entries = extractSceneEntityHandleGuids(
      scene.entities as unknown as ReadonlyArray<{
        readonly localId: number;
        readonly components: Record<string, Record<string, unknown>>;
      }>,
    );
    for (const entry of entries) {
      if (entry.guidString.toLowerCase() === subGuidKey) {
        return {
          sceneEntityId: entry.entityLocalId,
          componentField: `${entry.componentName}.${entry.fieldName}${entry.arrayIndex !== undefined ? `[${entry.arrayIndex}]` : ''}`,
        };
      }
    }
    return undefined;
  }

  /**
   * tweak-20260609 M1 helper: build the error-hint breadcrumb string
   * containing the parent asset's GUID + kind, enriched with the
   * caller-provided `parentContext` (entity localId + component.field).
   *
   * Per D-7 / B-8: the breadcrumb appears before the sub-asset's own hint,
   * separated by " / ".
   */
  private buildBreadcrumbHint(
    parentGuidKey: string,
    parentKind: string,
    subGuidKey: string,
    parentContext?: {
      sceneEntityId?: number;
      componentField?: string;
    },
  ): string {
    let breadcrumb = `sub-asset ${subGuidKey} referenced by ${parentKind} ${parentGuidKey}`;
    if (parentContext?.sceneEntityId !== undefined && parentContext?.componentField !== undefined) {
      breadcrumb += ` (entity ${parentContext.sceneEntityId}, field ${parentContext.componentField})`;
    }
    return breadcrumb;
  }

  /**
   * M4 transport fallback: try the injected {@link ImportTransport} to lazily
   * import a missing DDC, then re-enter the DDC load path. When no transport
   * is wired (shipped form), fail fast with `asset-not-imported` (AC-22).
   */
  private async transportOrFail<T extends Asset>(
    guid: AssetGuid,
    guidKey: string,
    _missReason: AssetErrorCode,
  ): Promise<Result<Handle<TagOf<T>, 'unmanaged'>, AssetError | ImageError | RhiError>> {
    if (this.importTransport === undefined) {
      // shipped form: no transport wired -> fail fast, never degrade to
      // runtime import (AC-22, charter P3 explicit failure).
      return err(
        new AssetError({
          code: 'asset-not-imported',
          expected: `GUID ${guidKey} to have been pre-imported at build time or to have an ImportTransport wired`,
          hint: ASSET_ERROR_HINTS['asset-not-imported'],
        }),
      );
    }

    // studio form: request the transport to import this GUID on-the-fly.
    // After a successful transport call the DDC is available; re-enter the
    // catalog + DDC load path (the transport writes the DDC but does NOT
    // register the asset — that's the Loader's job).
    const transportResult = await this.importTransport.fetchPack(guidKey);
    if (!transportResult.ok) {
      return err(
        new AssetError({
          code: 'asset-not-imported',
          expected: `import transport to fetch pack for GUID ${guidKey}`,
          hint: ASSET_ERROR_HINTS['asset-not-imported'],
        }),
      );
    }

    // Patch ONLY the freshly imported rows into the catalog cache (per-asset
    // incremental, the four-verb redesign 2026-06-06) instead of nuking the
    // cache and re-fetching the whole pack-index. The transport returns the one
    // imported entry (+ sub-asset siblings); each becomes / overwrites a cache
    // row. This keeps 122 concurrent texture imports O(N) instead of O(N^2)
    // whole-catalog re-fetches and never resets a sibling's imported row.
    const importedEntries = 'entries' in transportResult ? transportResult.entries : undefined;
    if (importedEntries !== undefined && importedEntries.length > 0) {
      if (this.packIndexCache === undefined) this.packIndexCache = new Map();
      for (const e of importedEntries) {
        this.packIndexCache.set(e.guid.toLowerCase(), {
          relativeUrl: e.relativeUrl,
          kind: e.kind,
          ...(e.metadata !== undefined ? { metadata: e.metadata } : {}),
        });
      }
    } else {
      // No inline rows -- fall back to a full pack-index re-read so the freshly
      // imported DDC entry is visible (legacy / non-row-returning transports).
      this.packIndexCache = undefined;
    }
    const entry = await this.resolveCatalogEntry(guidKey);
    if (entry === undefined) {
      return err(
        new AssetError({
          code: 'asset-not-imported',
          expected: `import transport to produce a catalog entry for GUID ${guidKey}`,
          hint: ASSET_ERROR_HINTS['asset-not-imported'],
        }),
      );
    }

    // Re-enter the DDC load path (identical to the catalog-hit path).
    return this.ddcLoad<T>(guid, guidKey, entry);
  }

  /**
   * Register a parsed asset POD (the synchronous tail of the DDC load path:
   * `registerWithGuid`). Material parent preload is handled asynchronously
   * inside `ddcLoad` before calling this method; the registered asset is
   * always fully resolved by the time it reaches here.
   *
   * Extracted from the old `loadByGuidProd` body so `ddcLoad` and
   * `transportOrFail` share an identical load path (AC-23 key invariant).
   */
  private registerParsedAsset<T extends Asset>(
    guid: AssetGuid,
    asset: Asset,
    _guidKey: string,
  ): Result<Handle<TagOf<T>, 'unmanaged'>, AssetError | ImageError | RhiError> {
    // bug-20260523 M3 / t9: registerWithGuid now validates mesh vertex stride
    // (throws AssetError on mismatch). Catch asset-registration errors
    // and return Result.err so loadByGuid surface is consistent with
    // the register() fail-fast shape (charter P4 consistent abstraction).
    try {
      return ok(this.registerWithGuid(guid, asset) as Handle<TagOf<T>, 'unmanaged'>);
    } catch (e: unknown) {
      if (
        typeof e === 'object' &&
        e !== null &&
        'code' in e &&
        typeof (e as Record<string, unknown>).code === 'string'
      ) {
        return err(e as AssetError);
      }
      throw e;
    }
  }

  /**
   * Fetch and parse pack-index.json into a Map<guidKey, {relativeUrl, kind}>.
   */
  private async fetchPackIndex(): Promise<
    Result<
      Map<
        string,
        {
          relativeUrl: string;
          kind: string;
          metadata?: ImageMetadata | CubeTextureMetadata | undefined;
        }
      >,
      AssetError
    >
  > {
    let raw: unknown;
    try {
      const res = await globalThis.fetch(this.packIndexUrl as string);
      if (!res.ok) {
        return err(
          new AssetError({
            code: 'asset-fetch-failed',
            expected: `fetch(${this.packIndexUrl}) to return ok`,
            hint: ASSET_ERROR_HINTS['asset-fetch-failed'],
          }),
        );
      }
      raw = (await res.json()) as unknown;
    } catch {
      return err(
        new AssetError({
          code: 'asset-fetch-failed',
          expected: `fetch(${this.packIndexUrl}) to succeed`,
          hint: ASSET_ERROR_HINTS['asset-fetch-failed'],
        }),
      );
    }

    if (!Array.isArray(raw)) {
      return err(
        new AssetError({
          code: 'asset-parse-failed',
          expected: 'pack-index.json to be a JSON array',
          hint: ASSET_ERROR_HINTS['asset-parse-failed'],
        }),
      );
    }

    const catalog = new Map<
      string,
      {
        relativeUrl: string;
        kind: string;
        metadata?: ImageMetadata | CubeTextureMetadata | undefined;
      }
    >();
    for (const item of raw as Array<{
      guid?: unknown;
      relativeUrl?: unknown;
      kind?: unknown;
      metadata?: unknown;
    }>) {
      if (
        typeof item.guid === 'string' &&
        typeof item.relativeUrl === 'string' &&
        typeof item.kind === 'string'
      ) {
        // metadata is the optional 5th field introduced by feat-20260517
        // D-2 (catalog builder writes it for kind: 'texture' rows; legacy
        // 4-field rows leave it undefined). Pass-through is structural --
        // runtime narrows on `entry.metadata !== undefined` inside the
        // texture arm and routes to `image-meta-missing` otherwise.
        catalog.set(item.guid.toLowerCase(), {
          relativeUrl: item.relativeUrl,
          kind: item.kind,
          metadata: item.metadata as ImageMetadata | CubeTextureMetadata | undefined,
        });
      }
    }
    return ok(catalog);
  }

  /**
   * Fetch a .pack.json file, find the asset entry matching guidKey, and
   * reconstruct the Asset from its payload.
   */
  /**
   * bug-20260610: fetch one pack file and return the raw asset entry without
   * parsing. Used by `loadByGuidProd` for material kinds so the caller can
   * recursively preload `refs[]` (texture sub-assets) BEFORE the synchronous
   * materialLoader runs and resolves paramValues handle fields against
   * `this.guidToHandle` via `LoadContext.resolveRefSync`.
   */
  private async fetchPackEntry(
    relativeUrl: string,
    guidKey: string,
  ): Promise<
    Result<{ kind: string; payload: Record<string, unknown>; refs?: string[] }, AssetError>
  > {
    let raw: unknown;
    try {
      const res = await globalThis.fetch(relativeUrl);
      if (!res.ok) {
        return err(
          new AssetError({
            code: 'asset-fetch-failed',
            expected: `fetch(${relativeUrl}) to return ok`,
            hint: ASSET_ERROR_HINTS['asset-fetch-failed'],
          }),
        );
      }
      raw = (await res.json()) as unknown;
    } catch {
      return err(
        new AssetError({
          code: 'asset-fetch-failed',
          expected: `fetch(${relativeUrl}) to succeed`,
          hint: ASSET_ERROR_HINTS['asset-fetch-failed'],
        }),
      );
    }
    const packFile = raw as {
      assets?: Array<{
        guid: string;
        kind: string;
        payload: Record<string, unknown>;
        refs?: string[];
      }>;
    };
    const assetEntry = (packFile.assets ?? []).find(
      (a) => a.guid.toLowerCase() === guidKey.toLowerCase(),
    );
    if (assetEntry === undefined) {
      return err(
        new AssetError({
          code: 'asset-not-found',
          expected: `GUID ${guidKey} present in pack file ${relativeUrl}`,
          hint: ASSET_ERROR_HINTS['asset-not-found'],
        }),
      );
    }
    return ok({
      kind: assetEntry.kind,
      payload: assetEntry.payload,
      ...(assetEntry.refs !== undefined ? { refs: assetEntry.refs } : {}),
    });
  }

  /**
   * Fetch one pack file, locate the requested asset entry, and either parse it
   * inline or expose the entry to the caller (for kinds that need to preload
   * `refs[]` BEFORE running the loader — currently 'material', whose
   * paramValues handle fields are resolved via `LoadContext.resolveRefSync`
   * against `this.guidToHandle`).
   *
   * bug-20260610 Fix B (M3 / D-4): the fetch+parse result is cached per
   * `relativeUrl` in `packFileCache`; concurrent calls for the same URL share
   * a single in-flight promise via `packFileInFlight`. Only the raw parsed
   * body is cached — `parseAssetPayload` still runs per-call (CON-2).
   */
  private async fetchPackFile(
    relativeUrl: string,
    guidKey: string,
    _kind: string,
  ): Promise<Result<Asset, AssetError>> {
    // ── cache hit ───────────────────────────────────────────────────────
    const cached = this.packFileCache.get(relativeUrl);
    if (cached !== undefined) {
      const assetEntry = cached.assets.find((a) => a.guid.toLowerCase() === guidKey.toLowerCase());
      if (assetEntry === undefined) {
        return err(
          new AssetError({
            code: 'asset-not-found',
            expected: `GUID ${guidKey} present in pack file ${relativeUrl}`,
            hint: ASSET_ERROR_HINTS['asset-not-found'],
          }),
        );
      }
      return this.parseAndReturnAsset(assetEntry);
    }

    // ── in-flight dedup ─────────────────────────────────────────────────
    const inFlight = this.packFileInFlight.get(relativeUrl);
    if (inFlight !== undefined) {
      try {
        const packFile = await inFlight;
        const assetEntry = packFile.assets.find(
          (a) => a.guid.toLowerCase() === guidKey.toLowerCase(),
        );
        if (assetEntry === undefined) {
          return err(
            new AssetError({
              code: 'asset-not-found',
              expected: `GUID ${guidKey} present in pack file ${relativeUrl}`,
              hint: ASSET_ERROR_HINTS['asset-not-found'],
            }),
          );
        }
        return this.parseAndReturnAsset(assetEntry);
      } catch {
        // In-flight promise rejected (network failure) — fall through to
        // re-fetch. The in-flight entry was already cleaned by the
        // catch block in the original miss path.
      }
    }

    // ── miss: fetch + parse + cache ─────────────────────────────────────
    return this.fetchAndCachePackFile(relativeUrl, guidKey);
  }

  /**
   * Parse the asset payload from a pack-file entry and return the result.
   * Extracted so cache-hit and in-flight-dedup paths share the same
   * parseAssetPayload + error-wrapping logic.
   */
  private parseAndReturnAsset(assetEntry: {
    kind: string;
    payload: Record<string, unknown>;
    refs?: string[];
  }): Result<Asset, AssetError> {
    const asset = this.parseAssetPayload(assetEntry.kind, assetEntry.payload, assetEntry.refs);
    if (asset === undefined) {
      const lastErr = this.lastParseSceneError;
      this.lastParseSceneError = undefined;
      if (lastErr) {
        return err(
          new AssetError({
            code: 'asset-parse-failed',
            expected: `refs index ${lastErr.index} within [0, ${lastErr.refsLength})`,
            detail: {
              localId: lastErr.localId,
              component: lastErr.component,
              field: lastErr.field,
              index: lastErr.index,
              refsLength: lastErr.refsLength,
            },
            hint:
              `at node localId=${lastErr.localId}, component=${lastErr.component}, ` +
              `field=${lastErr.field}: index ${lastErr.index} is out of bounds ` +
              `(refs has ${lastErr.refsLength} entries)`,
          }),
        );
      }
      return err(
        new AssetError({
          code: 'asset-parse-failed',
          expected: `parseable asset payload for kind ${assetEntry.kind}`,
          hint: ASSET_ERROR_HINTS['asset-parse-failed'],
        }),
      );
    }
    return ok(asset);
  }

  /**
   * Fetch a pack file from the network, parse the JSON body, store the
   * result in the cache, and return the requested asset entry.
   *
   * Registers the in-flight promise in `packFileInFlight` so concurrent
   * callers share a single fetch. On success the body moves to
   * `packFileCache`; on failure the in-flight entry is removed so
   * subsequent retries re-fetch (D-7).
   */
  private async fetchAndCachePackFile(
    relativeUrl: string,
    guidKey: string,
  ): Promise<Result<Asset, AssetError>> {
    const fetchPromise = (async (): Promise<ParsedPackFile> => {
      let raw: unknown;
      try {
        const res = await globalThis.fetch(relativeUrl);
        if (!res.ok) {
          throw new AssetError({
            code: 'asset-fetch-failed',
            expected: `fetch(${relativeUrl}) to return ok`,
            hint: ASSET_ERROR_HINTS['asset-fetch-failed'],
          });
        }
        raw = (await res.json()) as unknown;
      } catch (e) {
        if (e instanceof AssetError) throw e;
        throw new AssetError({
          code: 'asset-fetch-failed',
          expected: `fetch(${relativeUrl}) to succeed`,
          hint: ASSET_ERROR_HINTS['asset-fetch-failed'],
        });
      }
      // Shape guard: the dev-server / preview / 404 fallback can return
      // index.html or an unrelated JSON body that satisfies res.ok but lacks
      // the ParsedPackFile contract. Without this guard the downstream
      // `packFile.assets.find` raises TypeError outside any AssetError
      // branch, escapes as a process-level Unhandled Rejection, and drives
      // vitest browser-project exit=1 even when every onerror-gate test
      // assertion passes (feat-20260611 step-implement F-4).
      if (
        raw === null ||
        typeof raw !== 'object' ||
        !Array.isArray((raw as { assets?: unknown }).assets)
      ) {
        throw new AssetError({
          code: 'asset-fetch-failed',
          expected: `pack-file body at ${relativeUrl} to be { assets: [...] }`,
          hint: ASSET_ERROR_HINTS['asset-fetch-failed'],
        });
      }
      return raw as ParsedPackFile;
    })();

    this.packFileInFlight.set(relativeUrl, fetchPromise);

    try {
      const packFile = await fetchPromise;
      this.packFileCache.set(relativeUrl, packFile);
      this.packFileInFlight.delete(relativeUrl);

      const assetEntry = packFile.assets.find(
        (a) => a.guid.toLowerCase() === guidKey.toLowerCase(),
      );
      if (assetEntry === undefined) {
        return err(
          new AssetError({
            code: 'asset-not-found',
            expected: `GUID ${guidKey} present in pack file ${relativeUrl}`,
            hint: ASSET_ERROR_HINTS['asset-not-found'],
          }),
        );
      }
      return this.parseAndReturnAsset(assetEntry);
    } catch (e) {
      this.packFileInFlight.delete(relativeUrl);
      if (e instanceof AssetError) {
        return err(e);
      }
      throw e;
    }
  }

  /**
   * Reconstruct a typed `Asset` from a raw payload object.
   *
   * @param kind The asset kind discriminant (matches the pack entry or
   *   dev-register dispatch).
   * @param payload The serialised asset payload (keys mirror the asset
   *   interface field names).
   * @param refs Pack-file refs array for Handle fields — when a field
   *   value is `number` it resolves to `refs[N]` (glTF-style index).
   *   Optional to preserve compatibility with callers outside the pack
   *   ingestion path (e.g., direct `registerWithGuid`).
   */
  private parseAssetPayload(
    kind: string,
    payload: Record<string, unknown>,
    refs?: string[],
  ): Asset | undefined {
    // feat-20260603-asset-import-loader-injection M1 / w4: dispatch on
    // `kind` through the injected LoaderRegistry instead of a hardcoded
    // `if (kind === ...)` chain (D-1 / AC-01). The seven inline pack-payload
    // loaders parse synchronously; texture / font live on the upstream
    // loadByGuidProd branch (w6) and are never reached here. Unknown / stub
    // kinds (sampler / shader / render-pipeline / texture / font / audio) have
    // no inline loader -> `get` returns undefined -> the historical
    // `return undefined` fall-through is preserved.
    const loader = this.loaders.get(kind);
    if (loader === undefined) return undefined;
    const out = loader.load(payload, refs, this.makeLoadContext());
    // The inline pack-payload loaders are synchronous (`Asset | undefined`);
    // the async texture / font loaders are dispatched from loadByGuidProd, not
    // here. A Promise here would mean a misregistered loader -> treat as a
    // parse miss rather than leaking a thenable into the sync return.
    if (out !== undefined && typeof (out as { then?: unknown }).then === 'function') {
      return undefined;
    }
    return out as Asset | undefined;
  }

  /**
   * Build the {@link LoadContext} passed to a loader's `load`. The inline
   * pack-payload loaders use only `reportParseError` (the scene
   * error-contextualization channel, D-8); `fetchBinary` / `resolveRef` /
   * `device` are wired for the async texture / font loaders (w6).
   */
  private makeLoadContext(): LoadContext {
    return {
      fetchBinary: async (url: string) => {
        try {
          const res = await globalThis.fetch(url);
          if (!res.ok) {
            return {
              ok: false as const,
              error: new AssetError({
                code: 'asset-fetch-failed',
                expected: `fetch(${url}) to return ok`,
                hint: ASSET_ERROR_HINTS['asset-fetch-failed'],
              }),
            };
          }
          const buf = await res.arrayBuffer();
          return { ok: true as const, value: new Uint8Array(buf) };
        } catch {
          return {
            ok: false as const,
            error: new AssetError({
              code: 'asset-fetch-failed',
              expected: `fetch(${url}) to succeed`,
              hint: ASSET_ERROR_HINTS['asset-fetch-failed'],
            }),
          };
        }
      },
      resolveRef: async (guid: string) => {
        const parsed = AssetGuid.parse(guid);
        if (!parsed.ok) {
          return { ok: false as const, error: parsed.error };
        }
        const r = await this.loadByGuid(parsed.value);
        if (!r.ok) return { ok: false as const, error: r.error };
        return { ok: true as const, value: unwrapHandle(r.value as Handle<string, 'unmanaged'>) };
      },
      resolveRefSync: (guid: string) => {
        // guidToHandle is keyed by AssetGuid.format() output (RFC4122 dash-
        // form lowercase). Refs[] strings already use that form, but normalise
        // defensively.
        const handle = this.guidToHandle.get(guid.toLowerCase());
        if (handle === undefined) return undefined;
        return unwrapHandle(handle);
      },
      // feat-20260613-material-paramschema-driven-binding M4 / w22 (D-5 graceful):
      // expose the registered shader's derive(paramSchema).textureFieldNames to
      // the materialLoader so it can decide which paramValues fields carry
      // refs[] indices without a hardcoded texture-field allowlist Set
      // (AC-03). Returns `undefined` when the shader is not registered (cross-
      // worktree shader-late-register, plan R-4) — the loader then falls back
      // to a graceful "try every int paramValue" walk.
      getMaterialShaderTextureFieldNames: (shaderId: string) => {
        const lookup = this.shaderRegistry.lookupMaterialShader(shaderId);
        if (!lookup.ok) return undefined;
        return derive(lookup.value.paramSchema).textureFieldNames;
      },
      device: undefined,
      reportParseError: (detail: ParseErrorDetail) => {
        this.lastParseSceneError = detail;
      },
    };
  }

  /**
   * Return a runtime snapshot of every live handle. Each entry exposes
   * `{ id, brand, refcount: 'immortal' }` where `brand` is the 4-member
   * string literal union (`'MeshAsset' | 'TextureAsset' | 'SamplerAsset'
   * | 'MaterialAsset'`) mirroring the engine-types `Asset` discriminated
   * union.
   *
   * AI-user narrowing flow (AC-11 + plan-strategy §7.4):
   * ```ts
   * for (const e of registry.inspect().handles) {
   *   if (e.brand === 'TextureAsset') {
   *     // e.id is the u32; re-query via registry.get<TextureAsset>(...) to
   *     // get the typed Asset value back.
   *   }
   * }
   * ```
   */
  inspect(): InspectSnapshot {
    const handles: InspectEntry[] = [];
    for (const [id, asset] of this.assets) {
      handles.push({ id, brand: assetBrand(asset), refcount: 'immortal' });
    }
    return { handles };
  }
}
