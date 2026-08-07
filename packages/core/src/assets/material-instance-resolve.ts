// material-instance-resolve — pure inheritance + cycle-guard helpers for MI.
//
// Engine merge (`resolveMaterialAsset`) only understands material parent + values.
// This module resolves the editor MI model ({enabled,value} overrides) into a
// flat MaterialAsset.values map for preview / hot-patch / bake.
//
// Anchors: docs/2026-08-05-material-instance-editor-tech-plan.md §A2

import {
  MATERIAL_INSTANCE_KIND,
  isGuid,
  isMaterialInstancePayload,
  type MaterialInstanceOverride,
  type MaterialInstancePayload,
} from './material-instance-schema';

export interface MaterialCatalogEntry {
  readonly guid: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

export type MaterialCatalogLookup = (guid: string) => MaterialCatalogEntry | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function materialValuesOf(payload: Record<string, unknown>): Record<string, unknown> {
  return isRecord(payload.values) ? { ...payload.values } : {};
}

/**
 * Walk parent chain from `startGuid`. Returns true if `selfGuid` appears on the
 * chain (or equals the candidate) — i.e. assigning candidate as parent of self
 * would create a cycle.
 */
export function wouldCreateParentCycle(
  selfGuid: string,
  candidateParentGuid: string,
  lookup: MaterialCatalogLookup,
): boolean {
  if (!isGuid(selfGuid) || !isGuid(candidateParentGuid)) return true;
  if (selfGuid.toLowerCase() === candidateParentGuid.toLowerCase()) return true;

  const visited = new Set<string>();
  let current: string | undefined = candidateParentGuid;
  while (current !== undefined) {
    const key = current.toLowerCase();
    if (key === selfGuid.toLowerCase()) return true;
    if (visited.has(key)) return true; // existing cycle in catalog
    visited.add(key);

    const entry = lookup(current);
    if (!entry) return false;
    if (entry.kind === MATERIAL_INSTANCE_KIND && isMaterialInstancePayload(entry.payload)) {
      current = entry.payload.parent;
      continue;
    }
    if (entry.kind === 'material') {
      const parent = entry.payload.parent;
      current = typeof parent === 'string' && parent.length > 0 ? parent : undefined;
      continue;
    }
    return false;
  }
  return false;
}

/** Collect enabled override values from an MI payload (shallow). */
export function enabledOverrideValues(
  overrides: Readonly<Record<string, MaterialInstanceOverride>> | undefined,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!overrides) return result;
  for (const [key, override] of Object.entries(overrides)) {
    if (override?.enabled === true && override.value !== undefined) {
      result[key] = override.value;
    }
  }
  return result;
}

/**
 * Resolve an MI (or material) GUID into a flat MaterialAsset.values map by
 * walking parent chain (root → leaf) and applying enabled overrides last.
 */
export function resolveOverrides(
  miOrGuid: MaterialInstancePayload | string,
  lookup: MaterialCatalogLookup,
): Record<string, unknown> {
  const startGuid = typeof miOrGuid === 'string' ? miOrGuid : undefined;
  const startPayload = typeof miOrGuid === 'string' ? undefined : miOrGuid;

  const chain: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const visited = new Set<string>();

  if (startPayload) {
    chain.push({ kind: MATERIAL_INSTANCE_KIND, payload: startPayload as unknown as Record<string, unknown> });
    let current: string | undefined = startPayload.parent;
    while (current !== undefined) {
      const key = current.toLowerCase();
      if (visited.has(key)) break;
      visited.add(key);
      const entry = lookup(current);
      if (!entry) break;
      chain.push({ kind: entry.kind, payload: entry.payload });
      if (entry.kind === MATERIAL_INSTANCE_KIND && isMaterialInstancePayload(entry.payload)) {
        current = entry.payload.parent;
      } else if (entry.kind === 'material') {
        const parent = entry.payload.parent;
        current = typeof parent === 'string' && parent.length > 0 ? parent : undefined;
      } else {
        break;
      }
    }
  } else if (startGuid) {
    let current: string | undefined = startGuid;
    while (current !== undefined) {
      const key = current.toLowerCase();
      if (visited.has(key)) break;
      visited.add(key);
      const entry = lookup(current);
      if (!entry) break;
      chain.push({ kind: entry.kind, payload: entry.payload });
      if (entry.kind === MATERIAL_INSTANCE_KIND && isMaterialInstancePayload(entry.payload)) {
        current = entry.payload.parent;
      } else if (entry.kind === 'material') {
        const parent = entry.payload.parent;
        current = typeof parent === 'string' && parent.length > 0 ? parent : undefined;
      } else {
        break;
      }
    }
  }

  // Root first: reverse so deepest parent applies first.
  const ordered = chain.slice().reverse();
  const merged: Record<string, unknown> = {};
  for (const node of ordered) {
    if (node.kind === 'material') {
      Object.assign(merged, materialValuesOf(node.payload));
      continue;
    }
    if (node.kind === MATERIAL_INSTANCE_KIND && isMaterialInstancePayload(node.payload)) {
      Object.assign(merged, enabledOverrideValues(node.payload.overrides));
      Object.assign(merged, enabledOverrideValues(node.payload.propertyOverrides));
    }
  }
  return merged;
}

/** Inherited (pre-override) value for a single param key — parent resolve without this MI's overrides. */
export function getInheritedValue(
  mi: MaterialInstancePayload,
  paramKey: string,
  lookup: MaterialCatalogLookup,
): unknown {
  const parentResolved = resolveOverrides(mi.parent, lookup);
  return parentResolved[paramKey];
}
