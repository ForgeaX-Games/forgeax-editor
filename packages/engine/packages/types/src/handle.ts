// @forgeax/engine-types - Handle<T,M> brand + AssetTagMap + TagOf + 3 helpers SSOT.
//
// Single physical source-of-truth (feat-20260517-handle-type-unify M1 / D-2 / D-4 / D-7).
// The package barrel `index.ts` re-exports this file; AI users import the
// brand and helpers via `@forgeax/engine-types`, and IDE hover lands on this
// file (charter F1 single-entry indexability).
//
// Contents (charter P4 consistent abstraction - 5 co-located building blocks):
//   - type Handle<T extends string, M extends 'managed' | 'unmanaged'>
//     (double-axis phantom brand on top of `number`)
//   - type ManagedHandle<T> / UnmanagedHandle<T> (mode-pinned aliases)
//   - interface AssetTagMap (13-member closed map mesh/texture/cube-texture/sampler/material/scene/audio/skin/skeleton/animation-clip/shader/font/render-pipeline)
//   - type TagOf<T extends Asset> (distributive conditional - 13+1 never tail)
//   - function toManaged<T>(raw) / toUnmanaged<T>(raw) (brand creation factories)
//   - function unwrapHandle<T,M>(h) (brand removal helper - cast inverse)
//
// The single `as Handle<T, M>` cast inside each factory is the brand-creation
// structural cast (D-7 + AC-01 exemption); all other call sites must route
// through these factories or `unwrapHandle` so that no `as unknown as Handle`
// or `as unknown as number` literal survives anywhere outside this file
// (AC-01 grep gate, M3 / M4 cleanup).
//
// Charter mapping: F1 (single-entry IDE autocomplete from
// `@forgeax/engine-types`) + P3 (cross-mode rejection is a TS compile-time
// failure red line) + P4 (consistent abstraction: brand + map + 3 factories
// + 1 distributive conditional all co-located in this 1 file).

import type { Asset } from './index';

/**
 * Phantom-branded Handle: a `number` carrying two type tags.
 *
 * @typeParam T - asset target tag (string literal, e.g. `'MeshAsset'`)
 * @typeParam M - release mode: `'managed'` (ECS-tracked via ManagedRefStore)
 *   or `'unmanaged'` (external owner, e.g. `AssetRegistry`)
 *
 * Runtime representation is a u32 number so the GPU upload path
 * (`GPUBuffer.writeBuffer(slot, ...)`) keeps zero-cost passthrough; only the
 * TS layer enforces non-assignability across modes / targets via the
 * `__handle` phantom field. The `__handle` field is type-only - runtime
 * objects never carry it (charter P4 zero-overhead abstraction).
 *
 * Cross-tag rejection: `Handle<'MeshAsset', M>` is not assignable to
 * `Handle<'TextureAsset', M>` and vice versa (the brand `target` field
 * differs).
 *
 * Cross-mode rejection: `Handle<T, 'managed'>` is not assignable to
 * `Handle<T, 'unmanaged'>` and vice versa (the brand `mode` field differs);
 * this is the TS compile-time wall that prevents accidentally feeding a
 * managed handle to a registry that owns its own release lifecycle (charter
 * P3 explicit failure red line; tests live in
 * `packages/types/src/__tests__/handle-brand.test-d.ts` and
 * `packages/ecs/src/__tests__/handle.test-d.ts`).
 *
 * AI users do not write `as Handle<...>` - handles come from registry
 * factories (`engine.assets.register<T>(asset).unwrap()` produces
 * `Handle<TagOf<T>, 'unmanaged'>`; `world.managedRefs.alloc<T>(value)`
 * produces `Handle<T, 'managed'>`). The only `as Handle` literal in the
 * codebase is the brand-creation cast inside `toManaged` / `toUnmanaged`
 * below (AC-01 exemption).
 */
export type Handle<T extends string, M extends 'managed' | 'unmanaged'> = number & {
  readonly __handle: { readonly target: T; readonly mode: M };
};

/**
 * Convenience alias - managed-mode handle for asset target `T`.
 *
 * Intended for ECS-internal consumption (managed-ref-store.ts column slot
 * read sites). The `@forgeax/engine-ecs` barrel does NOT re-export this
 * alias name (AC-15 grep gate - keeps the AI-facing surface narrow);
 * callers outside ecs continue to write `Handle<T, 'managed'>` literally.
 *
 * Schema vocab `'ref<T>'` derives the column field type to this alias via
 * `FieldValueType<T>` conditional inference (see
 * `packages/ecs/src/component.ts`).
 */
export type ManagedHandle<T extends string> = Handle<T, 'managed'>;

/**
 * Convenience alias - unmanaged-mode handle for asset target `T`.
 *
 * Mirrors `ManagedHandle<T>` for the external-owner side; surfaces on
 * `AssetRegistry.register<T>` return signatures and `MeshFilter.assetHandle`
 * column type. Re-exported by the `@forgeax/engine-ecs` barrel (alongside
 * `Handle`) so AI users importing from ecs see the alias - this remains
 * subordinate to writing `Handle<T, 'unmanaged'>` literally.
 *
 * Schema vocab `'handle<T>'` derives the column field type to this alias
 * via `FieldValueType<T>` conditional inference.
 */
export type UnmanagedHandle<T extends string> = Handle<T, 'unmanaged'>;

/**
 * Asset.kind tag map - 13-member closed map keying each Asset variant
 * `kind` literal to its TS type name string literal (D-1 path (a)).
 *
 * Used by `TagOf<T>` distributive conditional below to derive the brand
 * `target` tag from an Asset variant TS type at register / inference time;
 * AI users adding a new Asset variant minor-add the corresponding
 * `kind -> 'XxxAsset'` row here so that `register<NewVariant>(asset)` returns
 * the correct `Handle<'XxxAsset', 'unmanaged'>` automatically (this map is
 * the single must-edit point per Asset addition - charter F1 single-entry
 * indexability).
 *
 * The 13 members align byte-for-byte with the closed `Asset` union; adding
 * a new member to `Asset` without adding a row here surfaces as a
 * `TagOf<NewAsset>` resolving to `never` (charter P3 explicit failure -
 * downstream `register<NewAsset>` calls fail to compile).
 */
export interface AssetTagMap {
  mesh: 'MeshAsset';
  texture: 'TextureAsset';
  'cube-texture': 'CubeTextureAsset';
  sampler: 'SamplerAsset';
  material: 'MaterialAsset';
  scene: 'SceneAsset';
  audio: 'AudioClipAsset';
  /** feat-20260523-skin-skeleton-animation M0 */
  skin: 'SkinAsset';
  /** feat-20260523-skin-skeleton-animation M0 */
  skeleton: 'SkeletonAsset';
  /** feat-20260523-skin-skeleton-animation M0 */
  'animation-clip': 'AnimationClip';
  /** feat-20260528-material-shader-registration-unification M1 / w1 */
  shader: 'ShaderAsset';
  /** feat-20260531-world-space-msdf-text-rendering M2 / w5 */
  font: 'FontAsset';
  /** feat-20260601-customizable-render-pipeline-seam-and-dogfood-rend M1 / w5 */
  'render-pipeline': 'RenderPipelineAsset';
}

/**
 * Distributive conditional - maps an Asset variant TS type to its brand
 * `target` tag string literal (D-1 path (a)).
 *
 * `TagOf<MeshAsset>` resolves to `'MeshAsset'`; `TagOf<MaterialAsset>`
 * resolves to `'MaterialAsset'` even though `MaterialAsset` is itself the
 * pass-based single interface (MaterialAsset) - the
 * distributive conditional resolves to 'MaterialAsset' via kind: 'material'
 * collapse onto `'MaterialAsset'` because both share `kind: 'material'`
 * (research Finding 2).
 *
 * Asset variants without a matching `AssetTagMap` row (or a `kind` literal
 * outside the 5 closed values) resolve to `never`, surfacing the missing
 * row at every downstream `register<T>` consumer site (charter P3 explicit
 * failure).
 */
export type TagOf<T extends Asset> = T extends { kind: infer K }
  ? K extends keyof AssetTagMap
    ? AssetTagMap[K]
    : never
  : never;

/**
 * Construct a `Handle<T, 'managed'>` from a raw u32. Brand-creation
 * structural cast - the `as Handle<T, 'managed'>` literal here is the
 * AC-01 exemption single point of brand creation (D-7); all other call
 * sites must route through this factory.
 *
 * Used by `ManagedRefStore.alloc<T>(value)` to brand fresh handles that
 * the ECS will track via the managed-ref release loop. AI users typically
 * do not call this directly - it is the brand-creation primitive that the
 * ecs / runtime layers wrap.
 */
export function toManaged<T extends string>(raw: number): Handle<T, 'managed'> {
  return raw as Handle<T, 'managed'>;
}

/**
 * Construct a `Handle<T, 'unmanaged'>` from a raw u32. Brand-creation
 * structural cast - the `as Handle<T, 'unmanaged'>` literal here is the
 * AC-01 exemption single point of brand creation (D-7).
 *
 * Used by `AssetRegistry.register<T>(asset).unwrap()` to brand the returned handle
 * with `Handle<TagOf<T>, 'unmanaged'>`, and by builtin handle constants
 * (`HANDLE_CUBE` / `HANDLE_TRIANGLE` / `HANDLE_ROOM_CUBE` / `BUILTIN_HANDLE_*`)
 * to brand compile-time u32 literals without caller-side `as unknown as`
 * casts (AC-05).
 */
export function toUnmanaged<T extends string>(raw: number): Handle<T, 'unmanaged'> {
  return raw as Handle<T, 'unmanaged'>;
}

/**
 * Remove the `Handle<T, M>` brand and recover the raw u32 carried inside.
 * Brand-removal helper - the inverse of `toManaged` / `toUnmanaged`.
 *
 * Runtime is identity (the brand `__handle` field is type-only; the
 * underlying number value is unchanged); the helper exists purely to
 * collapse all `as unknown as number` cast sites into a single function so
 * that AC-01 grep can surface stragglers (D-7 / D-8 cast collapse plan).
 *
 * Public on the types barrel (parallel to `toManaged` / `toUnmanaged`):
 * column read sites in managed-ref-store / scene-instance-container,
 * AssetRegistry internal `Map<number, ...>` key reads, and any AI-user
 * code that needs to bridge a branded handle to a numeric ABI all call
 * this. AI users on the typical spawn-site / register-site surface
 * usually do not need it (charter P1 progressive disclosure — handle
 * stays branded end-to-end), but when a numeric escape is required this
 * is the single sanctioned escape.
 */
export function unwrapHandle<T extends string, M extends 'managed' | 'unmanaged'>(
  h: Handle<T, M>,
): number {
  return h;
}
