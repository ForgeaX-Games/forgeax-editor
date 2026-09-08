// material-staging — per-GUID base Material edit buffer (STD-02).
//
// Edits land here first without immediately writing to disk; saving dispatches
// `updateMaterialParams` to flush staging → pack.
// PageController.prepareClose compares staging vs saved snapshot for dirty.

export interface MaterialStagingPayload {
  values: Record<string, unknown>;
  textureGuids: Record<string, string | null>;
  colorSpace?: 'srgb' | 'linear';
  parent?: string;
  passes?: unknown[];
}

export interface MaterialStagingEntry {
  guid: string;
  packPath: string;
  name: string;
  saved: MaterialStagingPayload;
  staging: MaterialStagingPayload;
}

const entries = new Map<string, MaterialStagingEntry>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function clonePayload(payload: MaterialStagingPayload): MaterialStagingPayload {
  return {
    values: structuredClone(payload.values ?? {}),
    textureGuids: structuredClone(payload.textureGuids ?? {}),
    colorSpace: payload.colorSpace,
    parent: payload.parent,
    passes: payload.passes ? structuredClone(payload.passes) : undefined,
  };
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) < 1e-6;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!valuesEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
      if (!valuesEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function payloadsEqual(a: MaterialStagingPayload, b: MaterialStagingPayload): boolean {
  if (!valuesEqual(a.values, b.values)) return false;
  const texKeysA = Object.keys(a.textureGuids ?? {});
  const texKeysB = Object.keys(b.textureGuids ?? {});
  const allTexKeys = new Set([...texKeysA, ...texKeysB]);
  for (const key of allTexKeys) {
    if ((a.textureGuids?.[key] ?? null) !== (b.textureGuids?.[key] ?? null)) {
      return false;
    }
  }
  return true;
}

export function subscribeMaterialStaging(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getMaterialStaging(guid: string): MaterialStagingEntry | undefined {
  return entries.get(guid.toLowerCase());
}

export function isMaterialStagingDirty(guid: string): boolean {
  const entry = getMaterialStaging(guid);
  if (!entry) return false;
  return !payloadsEqual(entry.saved, entry.staging);
}

/** GUIDs whose staging buffer differs from the last saved snapshot. */
export function listDirtyMaterialStagingGuids(): readonly string[] {
  const dirty: string[] = [];
  for (const entry of entries.values()) {
    if (!payloadsEqual(entry.saved, entry.staging)) {
      dirty.push(entry.guid);
    }
  }
  return dirty;
}

/** Open or refresh a staging buffer from a pack/catalog payload. */
export function openMaterialStaging(args: {
  readonly guid: string;
  readonly packPath: string;
  readonly name: string;
  readonly payload?: unknown;
}): MaterialStagingEntry {
  const key = args.guid.toLowerCase();
  const raw = (args.payload && typeof args.payload === 'object')
    ? (args.payload as Record<string, unknown>)
    : {};

  const payload: MaterialStagingPayload = {
    values: (raw.values && typeof raw.values === 'object') ? { ...(raw.values as Record<string, unknown>) } : {},
    textureGuids: {},
    colorSpace: raw.colorSpace === 'linear' ? 'linear' : 'srgb',
    parent: typeof raw.parent === 'string' ? raw.parent : undefined,
    passes: Array.isArray(raw.passes) ? [...raw.passes] : undefined,
  };

  const existing = entries.get(key);
  if (existing) {
    existing.packPath = args.packPath;
    existing.name = args.name;
    const clean = payloadsEqual(existing.saved, existing.staging);
    if (clean && Object.keys(payload.values).length > 0) {
      existing.saved = clonePayload(payload);
      existing.staging = clonePayload(payload);
    }
    notify();
    return existing;
  }

  const entry: MaterialStagingEntry = {
    guid: args.guid,
    packPath: args.packPath,
    name: args.name,
    saved: clonePayload(payload),
    staging: clonePayload(payload),
  };
  entries.set(key, entry);
  notify();
  return entry;
}

export function updateMaterialStaging(
  guid: string,
  updater: (staging: MaterialStagingPayload) => MaterialStagingPayload,
): MaterialStagingPayload | undefined {
  const entry = getMaterialStaging(guid);
  if (!entry) return undefined;
  entry.staging = clonePayload(updater(entry.staging));
  notify();
  return entry.staging;
}

export function patchMaterialStagingParam(
  guid: string,
  paramPatch: Record<string, unknown>,
  textureGuids?: Record<string, string | null>,
): MaterialStagingPayload | undefined {
  return updateMaterialStaging(guid, (staging) => {
    const nextValues = { ...staging.values };
    for (const [key, val] of Object.entries(paramPatch)) {
      if (val === undefined) delete nextValues[key];
      else nextValues[key] = val;
    }
    const nextTex = { ...staging.textureGuids };
    if (textureGuids) {
      for (const [key, texGuid] of Object.entries(textureGuids)) {
        if (texGuid === null) {
          delete nextTex[key];
          delete nextValues[key];
        } else {
          nextTex[key] = texGuid;
          nextValues[key] = texGuid;
        }
      }
    }
    return {
      ...staging,
      values: nextValues,
      textureGuids: nextTex,
    };
  });
}

export function resetMaterialStagingParam(
  guid: string,
  paramName: string,
  defaultValue?: unknown,
): MaterialStagingPayload | undefined {
  const entry = getMaterialStaging(guid);
  if (!entry) return undefined;
  return updateMaterialStaging(guid, (staging) => {
    const nextValues = { ...staging.values };
    const nextTex = { ...staging.textureGuids };
    if (paramName in entry.saved.values) {
      nextValues[paramName] = entry.saved.values[paramName];
    } else if (defaultValue !== undefined) {
      nextValues[paramName] = defaultValue;
    } else {
      delete nextValues[paramName];
    }
    if (paramName in (entry.saved.textureGuids ?? {})) {
      nextTex[paramName] = entry.saved.textureGuids[paramName] ?? null;
    } else {
      delete nextTex[paramName];
    }
    return {
      ...staging,
      values: nextValues,
      textureGuids: nextTex,
    };
  });
}

export function commitMaterialStaging(guid: string): MaterialStagingPayload | undefined {
  const entry = getMaterialStaging(guid);
  if (!entry) return undefined;
  entry.saved = clonePayload(entry.staging);
  notify();
  return entry.saved;
}

export function discardMaterialStaging(guid: string): MaterialStagingPayload | undefined {
  const entry = getMaterialStaging(guid);
  if (!entry) return undefined;
  entry.staging = clonePayload(entry.saved);
  notify();
  return entry.staging;
}

export function closeMaterialStaging(guid: string): void {
  if (entries.delete(guid.toLowerCase())) {
    notify();
  }
}
