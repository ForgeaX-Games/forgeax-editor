// Asset impact is a read-only projection of the producer catalog.
//
// The editor deliberately does not retain a second dependency index. Each
// call folds the current catalog relations (with the legacy `refs` fallback
// for rows that predate producer relations) into the bounded impact needed by
// delete, source move, and reimport decisions.

import type { AssetRelation } from '@forgeax/engine-types';

export type AssetMutationPreviewOperation = 'delete' | 'move' | 'reimport';

export interface AssetMutationPreviewRequest {
  readonly operation: AssetMutationPreviewOperation;
  readonly guid?: string;
  readonly sourcePath?: string;
}

export interface AssetImpactAsset {
  readonly guid: string;
  readonly kind?: string;
  readonly name?: string;
  readonly packageUrl?: string;
  readonly sourcePath?: string;
}

export interface AssetImpactEdge {
  readonly from: string;
  readonly to: string;
  readonly type: string;
  readonly policy?: AssetRelation['policy'];
  readonly provenance?: AssetRelation['provenance'];
  readonly source: 'producer-relation' | 'legacy-refs';
}

export interface AssetImpactResult {
  readonly operation: AssetMutationPreviewOperation;
  readonly resolution: 'resolved' | 'not-found' | 'invalid-selector';
  readonly selector: { readonly guid?: string; readonly sourcePath?: string };
  readonly targets: readonly AssetImpactAsset[];
  readonly directReferencers: readonly AssetImpactAsset[];
  readonly transitiveReferencers: readonly AssetImpactAsset[];
  readonly affectedAssets: readonly AssetImpactAsset[];
  readonly edges: readonly AssetImpactEdge[];
  readonly blocking: boolean;
  readonly confirmation: { readonly required: boolean };
  readonly hint?: string;
}

export interface AssetImpactCatalogRow {
  readonly guid: string;
  readonly kind: string;
  readonly name?: string;
  readonly packageUrl: string;
  readonly sourcePath?: string;
  readonly relations?: readonly AssetRelation[];
  readonly refs?: readonly string[];
}

function key(value: string): string {
  return value.toLowerCase();
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
}

function pathMatches(rowPath: string | undefined, requestedPath: string): boolean {
  if (rowPath === undefined) return false;
  const row = normalizePath(rowPath);
  const requested = normalizePath(requestedPath);
  return row === requested || row.endsWith(`/${requested}`);
}

function summary(row: AssetImpactCatalogRow | undefined, guid: string): AssetImpactAsset {
  return row === undefined
    ? { guid }
    : {
        guid: row.guid,
        kind: row.kind,
        ...(row.name === undefined ? {} : { name: row.name }),
        packageUrl: row.packageUrl,
        ...(row.sourcePath === undefined ? {} : { sourcePath: row.sourcePath }),
      };
}

function edgeRows(row: AssetImpactCatalogRow): AssetImpactEdge[] {
  if (row.relations !== undefined && row.relations.length > 0) {
    return row.relations.map((relation) => ({
      from: relation.from.id,
      to: relation.to.id,
      type: relation.type,
      ...(relation.policy === undefined ? {} : { policy: relation.policy }),
      ...(relation.provenance === undefined ? {} : { provenance: relation.provenance }),
      source: 'producer-relation' as const,
    }));
  }
  return (row.refs ?? []).map((ref) => ({
    from: row.guid,
    to: ref,
    type: 'references',
    source: 'legacy-refs' as const,
  }));
}

function stableAssets(
  ids: Iterable<string>,
  rows: ReadonlyMap<string, AssetImpactCatalogRow>,
): AssetImpactAsset[] {
  return [...new Set([...ids].map(key))]
    .sort()
    .map((id) => summary(rows.get(id), id));
}

/** Derive the bounded reference impact from the current producer catalog. */
export function deriveAssetImpact(
  catalog: readonly AssetImpactCatalogRow[],
  request: AssetMutationPreviewRequest,
): AssetImpactResult {
  const selector = {
    ...(request.guid === undefined ? {} : { guid: request.guid }),
    ...(request.sourcePath === undefined ? {} : { sourcePath: request.sourcePath }),
  };
  const rows = new Map(catalog.map((row) => [key(row.guid), row]));
  const edges = catalog.flatMap(edgeRows);
  const { guid, sourcePath } = request;
  const hasGuid = guid !== undefined;
  const hasSourcePath = sourcePath !== undefined;
  const targets = hasGuid && !hasSourcePath
    ? [rows.get(key(guid))].filter((row): row is AssetImpactCatalogRow => row !== undefined)
    : hasSourcePath && !hasGuid
      ? catalog.filter((row) => pathMatches(row.sourcePath, sourcePath))
      : [];
  const targetIds = new Set(targets.map((row) => key(row.guid)));
  if (hasGuid === hasSourcePath) {
    return {
      operation: request.operation,
      resolution: 'invalid-selector',
      selector,
      targets: [],
      directReferencers: [],
      transitiveReferencers: [],
      affectedAssets: [],
      edges: [],
      blocking: false,
      confirmation: { required: false },
      hint: 'asset impact requires exactly one guid or sourcePath selector',
    };
  }
  if (targets.length === 0) {
    return {
      operation: request.operation,
      resolution: 'not-found',
      selector,
      targets: [],
      directReferencers: [],
      transitiveReferencers: [],
      affectedAssets: [],
      edges: [],
      blocking: false,
      confirmation: { required: false },
      hint: request.guid === undefined
        ? `no catalog asset matches sourcePath ${request.sourcePath}`
        : `no catalog asset matches guid ${request.guid}`,
    };
  }

  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    const target = key(edge.to);
    const referencer = key(edge.from);
    const current = incoming.get(target) ?? [];
    if (!current.includes(referencer)) incoming.set(target, [...current, referencer]);
  }

  const directIds = new Set<string>();
  const allIds = new Set<string>();
  const queue = [...targetIds];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;
    for (const referencer of incoming.get(current) ?? []) {
      if (targetIds.has(referencer) || allIds.has(referencer)) continue;
      allIds.add(referencer);
      if (targetIds.has(current)) directIds.add(referencer);
      queue.push(referencer);
    }
  }

  const affectedIds = new Set([...targetIds, ...allIds]);
  const affectedEdges = edges
    .filter((edge) => affectedIds.has(key(edge.to)) && affectedIds.has(key(edge.from)))
    .sort((left, right) => `${key(left.from)}:${left.type}:${key(left.to)}`.localeCompare(`${key(right.from)}:${right.type}:${key(right.to)}`));
  return {
    operation: request.operation,
    resolution: 'resolved',
    selector,
    targets: stableAssets(targetIds, rows),
    directReferencers: stableAssets(directIds, rows),
    transitiveReferencers: stableAssets(allIds, rows).filter((asset) => !directIds.has(key(asset.guid))),
    affectedAssets: stableAssets(affectedIds, rows),
    edges: affectedEdges,
    blocking: request.operation === 'delete' && directIds.size > 0,
    confirmation: { required: request.operation === 'delete' && directIds.size > 0 },
  };
}
