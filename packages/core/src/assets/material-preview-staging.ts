// assets/material-preview-staging — transient UI overlay + preview value SSOT.
// Engine preview descriptors remain the canonical preview binding; this
// channel carries unsaved drag values and never registers an operation.
// for the base-Material editor page.
//
// WHY THIS EXISTS
//   The Material page's 3D preview lives in a SEPARATE preview world
//   (assembleMaterialPreviewWorld), so the main-world hot patch
//   (patchLiveMaterialParams, fired by the updateMaterialParams applier after
//   the pack write lands) never reaches it. The preview instead re-resolves
//   the material's values on `assetsChanged` — which only fires on COMMIT.
//   Slider drags would otherwise show nothing until mouseup.
//
//   This module is the chrome-side bridge: the properties panel publishes the
//   in-progress drag value here (no ledger entry, no disk write — north-star
//   §8 transient-preview discipline), the preview viewport overlays it on the
//   resolved values, and the panel clears the staged keys when the commit
//   dispatch goes out. It mirrors mi-staging's subscribe/notify shape but is
//   deliberately much smaller: no dirty tracking, no save semantics — a staged
//   value is meaningless the moment the commit (or any assetsChanged) lands.

import { getMaterialStaging } from './material-staging';
import { resolveOverrides, type MaterialCatalogLookup } from './material-instance-resolve';

const stagedByGuid = new Map<string, Record<string, unknown>>();
const listeners = new Set<(guid: string) => void>();

function omitNullishValues(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined && value !== null),
  );
}

/**
 * Flat value map for the Material page 3D preview. Mirrors the properties
 * panel: catalog inheritance → live staging buffer → transient drag overlay.
 * Staging is authoritative over catalog so a stale registry rebuild cannot
 * revert the sphere after save.
 */
export function resolveMaterialPreviewDisplayValues(
  guid: string,
  lookup: MaterialCatalogLookup,
): Record<string, unknown> {
  const fromCatalog = resolveOverrides(guid, lookup);
  const staging = getMaterialStaging(guid);
  const fromStaging = staging
    ? {
      ...staging.staging.values,
      ...(staging.staging.textureGuids ?? {}),
    }
    : {};
  const fromOverlay = getMaterialPreviewParams(guid);
  return omitNullishValues({
    ...fromCatalog,
    ...fromStaging,
    ...fromOverlay,
  });
}

function notify(guid: string): void {
  for (const listener of listeners) listener(guid);
}

/** Publish (or overwrite) one transient preview value for a material. */
export function setMaterialPreviewParam(guid: string, key: string, value: unknown): void {
  const id = guid.toLowerCase();
  const entry = stagedByGuid.get(id) ?? {};
  if (value === undefined || value === null) {
    delete entry[key];
    if (Object.keys(entry).length === 0) {
      stagedByGuid.delete(id);
    } else {
      stagedByGuid.set(id, entry);
    }
  } else {
    entry[key] = value;
    stagedByGuid.set(id, entry);
  }
  notify(id);
}

/** Clear staged values — `keys` omitted clears the whole material entry. */
export function clearMaterialPreviewParams(guid: string, keys?: readonly string[]): void {
  const id = guid.toLowerCase();
  const entry = stagedByGuid.get(id);
  if (!entry) return;
  if (keys === undefined) {
    stagedByGuid.delete(id);
  } else {
    for (const key of keys) delete entry[key];
    if (Object.keys(entry).length === 0) stagedByGuid.delete(id);
  }
  notify(id);
}

/** Current staged overlay for a material ({} when nothing is staged). */
export function getMaterialPreviewParams(guid: string): Readonly<Record<string, unknown>> {
  return stagedByGuid.get(guid.toLowerCase()) ?? {};
}

export function subscribeMaterialPreviewParams(listener: (guid: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
