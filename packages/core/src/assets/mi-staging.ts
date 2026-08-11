// mi-staging — per-GUID Material Instance edit buffer (M4/B2).
//
// Edits land here first; `saveMaterialInstance` flushes staging → pack.
// PageController.prepareClose compares staging vs saved snapshot for dirty.

import {
  createDefaultMaterialInstancePayload,
  isMaterialInstancePayload,
  type MaterialInstancePayload,
} from './material-instance-schema';

export interface MiStagingEntry {
  guid: string;
  packPath: string;
  name: string;
  saved: MaterialInstancePayload;
  staging: MaterialInstancePayload;
}

const entries = new Map<string, MiStagingEntry>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function clonePayload(payload: MaterialInstancePayload): MaterialInstancePayload {
  return structuredClone(payload);
}

function payloadsEqual(a: MaterialInstancePayload, b: MaterialInstancePayload): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function subscribeMiStaging(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getMiStaging(guid: string): MiStagingEntry | undefined {
  return entries.get(guid.toLowerCase());
}

export function isMiStagingDirty(guid: string): boolean {
  const entry = getMiStaging(guid);
  if (!entry) return false;
  return !payloadsEqual(entry.saved, entry.staging);
}

/** Open or refresh a staging buffer from a pack/catalog payload. */
export function openMiStaging(args: {
  readonly guid: string;
  readonly packPath: string;
  readonly name: string;
  readonly payload?: unknown;
}): MiStagingEntry {
  const key = args.guid.toLowerCase();
  let payload: MaterialInstancePayload;
  if (isMaterialInstancePayload(args.payload)) {
    payload = args.payload;
  } else {
    const parentCandidate = (args.payload as { parent?: unknown } | undefined)?.parent;
    const parent = typeof parentCandidate === 'string' && parentCandidate.length > 0
      ? parentCandidate
      : '00000000-0000-4000-8000-000000000000';
    try {
      payload = createDefaultMaterialInstancePayload(parent);
    } catch {
      payload = createDefaultMaterialInstancePayload('00000000-0000-4000-8000-000000000000');
    }
  }
  const existing = entries.get(key);
  if (existing) {
    existing.packPath = args.packPath;
    existing.name = args.name;
    // Do NOT overwrite saved/staging when the entry already exists.
    // The staging was initialized on first open; a re-mount (React
    // StrictMode, HMR, tab re-focus) must not clobber committed edits
    // with a potentially stale catalog payload. The user can close and
    // reopen the tab to pull fresh disk content.
    notify();
    return existing;
  }
  const entry: MiStagingEntry = {
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

export function updateMiStaging(
  guid: string,
  updater: (staging: MaterialInstancePayload) => MaterialInstancePayload,
): MaterialInstancePayload | undefined {
  const entry = getMiStaging(guid);
  if (!entry) return undefined;
  entry.staging = clonePayload(updater(entry.staging));
  notify();
  return entry.staging;
}

export function commitMiStaging(guid: string): MaterialInstancePayload | undefined {
  const entry = getMiStaging(guid);
  if (!entry) return undefined;
  entry.saved = clonePayload(entry.staging);
  notify();
  return entry.saved;
}

export function discardMiStaging(guid: string): MaterialInstancePayload | undefined {
  const entry = getMiStaging(guid);
  if (!entry) return undefined;
  entry.staging = clonePayload(entry.saved);
  notify();
  return entry.staging;
}

export function closeMiStaging(guid: string): void {
  if (entries.delete(guid.toLowerCase())) notify();
}
