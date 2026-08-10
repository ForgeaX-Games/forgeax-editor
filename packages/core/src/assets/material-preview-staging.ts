// assets/material-preview-staging — transient (chrome-only) preview channel
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

const stagedByGuid = new Map<string, Record<string, unknown>>();
const listeners = new Set<(guid: string) => void>();

function notify(guid: string): void {
  for (const listener of listeners) listener(guid);
}

/** Publish (or overwrite) one transient preview value for a material. */
export function setMaterialPreviewParam(guid: string, key: string, value: unknown): void {
  const id = guid.toLowerCase();
  const entry = stagedByGuid.get(id) ?? {};
  entry[key] = value;
  stagedByGuid.set(id, entry);
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
