// input-map-staging — per-GUID Input Map edit buffer.
//
// Edits land here first; `saveInputMap` flushes staging → pack.
// PageController.prepareClose compares staging vs saved snapshot for dirty.

import {
  createDefaultInputMapPayload,
  isInputMapPayload,
  type InputMapPayload,
} from './input-map-schema';

export interface InputMapStagingEntry {
  guid: string;
  packPath: string;
  name: string;
  saveStatus: 'idle' | 'saving';
  saved: InputMapPayload;
  staging: InputMapPayload;
  external?: {
    name: string;
    payload: InputMapPayload;
  };
}

const entries = new Map<string, InputMapStagingEntry>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function clonePayload(payload: InputMapPayload): InputMapPayload {
  return structuredClone(payload);
}

function payloadsEqual(a: InputMapPayload, b: InputMapPayload): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function subscribeInputMapStaging(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getInputMapStaging(guid: string): InputMapStagingEntry | undefined {
  return entries.get(guid.toLowerCase());
}

export function isInputMapStagingDirty(guid: string): boolean {
  const entry = getInputMapStaging(guid);
  if (!entry) return false;
  return !payloadsEqual(entry.saved, entry.staging);
}

export function hasInputMapExternalChange(guid: string): boolean {
  return getInputMapStaging(guid)?.external !== undefined;
}

/** Apply asset metadata that changed independently of the editable payload.
 * Dirty edits and a pending external-payload decision remain untouched. */
export function renameInputMapStaging(guid: string, name: string): boolean {
  const entry = getInputMapStaging(guid);
  if (!entry || entry.name === name) return false;
  entry.name = name;
  notify();
  return true;
}

export function setInputMapSaveStatus(
  guid: string,
  saveStatus: InputMapStagingEntry['saveStatus'],
): boolean {
  const entry = getInputMapStaging(guid);
  if (!entry || entry.saveStatus === saveStatus) return false;
  entry.saveStatus = saveStatus;
  notify();
  return true;
}

export function openInputMapStaging(args: {
  readonly guid: string;
  readonly packPath: string;
  readonly name: string;
  readonly payload?: unknown;
}): InputMapStagingEntry {
  const key = args.guid.toLowerCase();
  const payload = isInputMapPayload(args.payload)
    ? args.payload
    : createDefaultInputMapPayload();
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
  const entry: InputMapStagingEntry = {
    guid: args.guid,
    packPath: args.packPath,
    name: args.name,
    saveStatus: 'idle',
    saved: clonePayload(payload),
    staging: clonePayload(payload),
  };
  entries.set(key, entry);
  notify();
  return entry;
}

/** Replace a clean opening snapshot with the pack-owned payload. Persisted page
 * metadata may be stale after a browser refresh; an in-progress edit wins. */
export function refreshInputMapStaging(args: {
  readonly guid: string;
  readonly packPath: string;
  readonly name: string;
  readonly payload: InputMapPayload;
}): InputMapStagingEntry {
  const existing = getInputMapStaging(args.guid);
  if (!existing) return openInputMapStaging(args);
  existing.packPath = args.packPath;
  if (!isInputMapStagingDirty(args.guid)) {
    existing.name = args.name;
    existing.saved = clonePayload(args.payload);
    existing.staging = clonePayload(args.payload);
    delete existing.external;
  } else if (payloadsEqual(existing.staging, args.payload)) {
    existing.name = args.name;
    existing.saved = clonePayload(args.payload);
    delete existing.external;
  } else if (payloadsEqual(existing.saved, args.payload)) {
    delete existing.external;
  } else {
    existing.external = {
      name: args.name,
      payload: clonePayload(args.payload),
    };
  }
  notify();
  return existing;
}

export function reloadInputMapStaging(guid: string): InputMapPayload | undefined {
  const entry = getInputMapStaging(guid);
  if (!entry?.external) return undefined;
  entry.name = entry.external.name;
  entry.saved = clonePayload(entry.external.payload);
  entry.staging = clonePayload(entry.external.payload);
  delete entry.external;
  notify();
  return entry.staging;
}

export function keepInputMapStaging(guid: string): InputMapPayload | undefined {
  const entry = getInputMapStaging(guid);
  if (!entry?.external) return undefined;
  entry.saved = clonePayload(entry.external.payload);
  delete entry.external;
  notify();
  return entry.staging;
}

export function updateInputMapStaging(
  guid: string,
  updater: (staging: InputMapPayload) => InputMapPayload,
): InputMapPayload | undefined {
  const entry = getInputMapStaging(guid);
  if (!entry) return undefined;
  entry.staging = clonePayload(updater(entry.staging));
  notify();
  return entry.staging;
}

export function commitInputMapStaging(guid: string): InputMapPayload | undefined {
  const entry = getInputMapStaging(guid);
  if (!entry) return undefined;
  entry.saved = clonePayload(entry.staging);
  delete entry.external;
  notify();
  return entry.saved;
}

export function discardInputMapStaging(guid: string): InputMapPayload | undefined {
  const entry = getInputMapStaging(guid);
  if (!entry) return undefined;
  entry.staging = clonePayload(entry.saved);
  delete entry.external;
  notify();
  return entry.staging;
}

export function closeInputMapStaging(guid: string): void {
  entries.delete(guid.toLowerCase());
  notify();
}
