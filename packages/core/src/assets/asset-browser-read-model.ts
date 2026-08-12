// asset-browser-read-model — canonical read model for Content Browser data
// (editor data-operation-view convergence M2).
//
// This module owns only environment reads and the catalog/tree/sidecar join. It
// has no React dependency and never creates an AssetRegistry. Asset identity is
// catalog-only; sidecars contribute source/indexing state and diagnostics.

import { createAssetWorkspace, type AssetWorkspaceSnapshot, type AssetWorkspaceIssue } from '@forgeax/editor-product';
import type {
  AssetAuthoringCapability,
  CatalogDelta,
  CatalogDiagnostic,
  CatalogEntry,
  CatalogLifecycle,
  CatalogProjection,
  CatalogSubject,
  CookExecution,
  ProviderProvenance,
  ResourceRevision,
  SourceOverrideDescriptor,
  SourceOverrideMap,
  AssetRelation as ProducerAssetRelation,
} from '@forgeax/engine-types';

export type { AssetAuthoringCapability } from '@forgeax/engine-types';

import { projectCatalogPathToRoots, type CatalogRootProjection } from './catalog-storage-path';

export type AssetBrowserCatalogRoot = CatalogRootProjection;

export type AssetBrowserRelationKind = 'depends-on' | 'referenced-by' | 'contains' | 'derived-from';

export interface AssetBrowserCatalogRelation {
  readonly kind: AssetBrowserRelationKind;
  readonly from: string;
  readonly to: string;
}

export interface AssetBrowserRegistryEntry {
  readonly guid: string;
  readonly kind: string;
  readonly name?: string;
  readonly packageUrl: string;
  readonly refs?: readonly string[];
  /** Producer-owned graph facts; browser relations are accepted for projected snapshots. */
  readonly relations?: readonly (ProducerAssetRelation | AssetBrowserCatalogRelation)[];
  readonly sourcePath?: string;
  readonly sourceKey?: string;
  readonly revision?: string | ResourceRevision;
  /** Producer-owned relations; consumers must not infer source identity from paths. */
  /** Producer-owned placement/binding facts; consumers must not infer from kind. */
  readonly authoring?: AssetAuthoringCapability;
  readonly packageId?: string;
  readonly provenance?: ProviderProvenance;
  readonly sourceIndex?: number;
  readonly sourceOverrides?: SourceOverrideMap;
  readonly sourceOverrideDescriptors?: readonly SourceOverrideDescriptor[];
  readonly diagnostics?: readonly CatalogDiagnostic[];
  readonly cookReceiptUrl?: string;
  readonly subject?: CatalogSubject;
  readonly execution?: CookExecution;
  readonly lifecycle?: CatalogLifecycle;
  readonly projection?: CatalogProjection;
  readonly catalogRevision?: ResourceRevision;
}

export interface AssetBrowserCatalogSnapshot {
  readonly version: number;
  readonly entries: readonly CatalogEntry[];
  readonly stale: boolean;
  readonly diagnostics: readonly CatalogDiagnostic[];
}

export interface AssetBrowserRegistry {
  listCatalog(): readonly AssetBrowserRegistryEntry[];
  refreshCatalog?: () => Promise<boolean>;
  catalogSnapshot?: () => AssetBrowserCatalogSnapshot | undefined;
  subscribeCatalog?: (listener: (delta: CatalogDelta) => void) => () => void;
  reconcileCatalog?: () => Promise<AssetBrowserCatalogSnapshot | undefined>;
}

export interface AssetBrowserTreeNode {
  readonly type: 'dir' | 'file';
  readonly name: string;
  readonly path: string;
  readonly children?: readonly AssetBrowserTreeNode[];
}

export interface AssetBrowserFile {
  readonly path: string;
  readonly diskPath: string;
  readonly name: string;
}

export interface AssetBrowserDirectory {
  readonly path: string;
  readonly diskPath: string;
  readonly name: string;
}

export interface AssetBrowserAsset {
  readonly guid: string;
  readonly kind: string;
  readonly name: string;
  readonly packageUrl: string;
  /** Original catalog coordinate for an inline `.pack.json` CRUD target. */
  readonly storagePackageUrl: string;
  readonly sourcePath?: string;
  readonly sourceKey?: string;
  readonly revision?: string;
  readonly catalogRevision?: ResourceRevision;
  readonly packageId?: string;
  readonly provenance?: ProviderProvenance;
  readonly sourceIndex?: number;
  readonly sourceOverrides?: SourceOverrideMap;
  readonly sourceOverrideDescriptors?: readonly SourceOverrideDescriptor[];
  readonly diagnostics?: readonly CatalogDiagnostic[];
  readonly cookReceiptUrl?: string;
  readonly subject?: CatalogSubject;
  readonly execution?: CookExecution;
  readonly lifecycle?: CatalogLifecycle;
  readonly projection?: CatalogProjection;
  readonly metaPath?: string;
  readonly metaRevision?: string;
  /** Original catalog coordinate for file mutations. `sourcePath` is projected
   * into the browser's declared-root coordinate space for joining and display;
   * this value deliberately remains in the file backend's address space. */
  readonly storageSourcePath?: string;
  readonly refs: readonly string[];
  readonly relations: readonly AssetBrowserCatalogRelation[];
  readonly catalogRelations?: readonly ProducerAssetRelation[];
  /** Producer-owned placement/binding facts projected without reinterpretation. */
  readonly authoring?: AssetAuthoringCapability;
}

export type AssetSourcePhase = 'raw' | 'pending-index' | 'indexed' | 'invalid-meta';

export interface AssetSourceState {
  readonly sourcePath: string;
  readonly metaPath?: string;
  readonly phase: AssetSourcePhase;
  readonly catalogGuids: readonly string[];
  readonly observedMetaGuids: readonly string[];
  readonly metaRevision?: string;
  readonly sourceKeys: readonly string[];
}

export interface AssetBrowserDiagnostic {
  readonly code: 'TREE_READ_FAILED' | 'SIDECAR_READ_FAILED' | 'INVALID_META' | 'CATALOG_STALE' | 'CATALOG_DIAGNOSTIC';
  readonly path?: string;
  readonly message: string;
  readonly detail?: CatalogDiagnostic;
}

export interface AssetBrowserSnapshot {
  readonly generation: number;
  readonly files: readonly AssetBrowserFile[];
  readonly directories: readonly AssetBrowserDirectory[];
  readonly assets: readonly AssetBrowserAsset[];
  readonly sources: readonly AssetSourceState[];
  readonly diagnostics: readonly AssetBrowserDiagnostic[];
  readonly catalogVersion?: number;
  readonly catalogStale?: boolean;
  readonly catalogDiagnostics?: readonly CatalogDiagnostic[];
  readonly reconcileRequired?: boolean;
  readonly workspace?: AssetWorkspaceSnapshot;
}

export interface AssetBrowserReadModel {
  snapshot(): AssetBrowserSnapshot;
  subscribe(listener: (snapshot: AssetBrowserSnapshot) => void): () => void;
  refresh(hint?: 'directory-only' | 'pack-changed'): Promise<AssetBrowserSnapshot>;
  reconcile(): Promise<AssetBrowserSnapshot>;
}

export interface CreateAssetBrowserReadModelDeps {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  registry: AssetBrowserRegistry;
  resolveGamePath: (relativePath: string) => string;
  catalogRoots: readonly AssetBrowserCatalogRoot[];
}

/** Project the workspace SSOT into the legacy browser shape without owning it. */
export function assetWorkspaceSnapshotToBrowserSnapshot(
  workspace: AssetWorkspaceSnapshot,
): AssetBrowserSnapshot {
  const relations = workspace.relations;
  const refsBySubject = new Map<string, string[]>();
  for (const relation of relations) {
    if (relation.kind !== 'depends-on') continue;
    refsBySubject.set(relation.from, [...(refsBySubject.get(relation.from) ?? []), relation.to]);
  }
  return Object.freeze({
    generation: Number(workspace.revision.split(':r')[1] ?? 0),
    files: Object.freeze([]),
    directories: Object.freeze([]),
    assets: Object.freeze(workspace.subjects.map((subject) => ({
      guid: subject.id,
      kind: subject.kind,
      name: subject.name ?? subject.id,
      packageUrl: subject.path,
      storagePackageUrl: subject.path,
      sourcePath: subject.path,
      storageSourcePath: subject.path,
      refs: Object.freeze(refsBySubject.get(subject.id) ?? []),
      relations: Object.freeze(workspace.relations.filter((relation) => relation.from === subject.id || relation.to === subject.id)),
    }))),
    sources: Object.freeze([]),
    diagnostics: Object.freeze(workspace.issues.map((issue) => ({
      code: 'INVALID_META' as const,
      path: issue.subjectId,
      message: issue.message,
    }))),
    workspace,
  });
}

interface SidecarObservation {
  sourcePath: string;
  metaPath: string;
  subAssets: { guid: string; kind?: string; sourceKey?: string }[];
  metaRevision?: string;
  sourceKeys: readonly string[];
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
}

function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

// SSOT: the prefix projection itself lives in catalog-storage-path.ts (shared
// with the destroyAsset storage-path derivation); this wrapper keeps the read
// model's "unmatched rows pass through normalized" behaviour.
function projectCatalogPath(path: string, roots: readonly AssetBrowserCatalogRoot[]): string {
  return projectCatalogPathToRoots(path, roots) ?? normalize(path);
}

function relativeToGamePath(path: string, resolvedRoot: string): string {
  const normalized = normalize(path);
  const root = normalize(resolvedRoot).replace(/\/+$/, '');
  if (normalized === root) return '';
  if (root && normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  return normalized;
}

function producerRelationToBrowserRelation(relation: ProducerAssetRelation): AssetBrowserCatalogRelation {
  const kind = relation.type === 'contains' || relation.type === 'owns'
    ? 'contains'
    : relation.type === 'produces' || relation.type === 'materialized-as'
      ? 'derived-from'
      : 'depends-on';
  return { kind, from: relation.from.id.toLowerCase(), to: relation.to.id.toLowerCase() };
}

function isProducerRelation(
  relation: ProducerAssetRelation | AssetBrowserCatalogRelation,
): relation is ProducerAssetRelation {
  return 'type' in relation;
}

function isBrowserRelation(
  relation: ProducerAssetRelation | AssetBrowserCatalogRelation,
): relation is AssetBrowserCatalogRelation {
  return 'kind' in relation;
}

function flattenTree(
  node: AssetBrowserTreeNode,
  resolvedRoot: string,
  files: AssetBrowserFile[],
  directories: AssetBrowserDirectory[],
): void {
  const relativePath = relativeToGamePath(node.path, resolvedRoot);
  if (node.type === 'file') {
    if (relativePath) files.push({ path: relativePath, diskPath: node.path, name: node.name });
  } else if (relativePath) {
    directories.push({ path: relativePath, diskPath: node.path, name: node.name });
  }
  for (const child of node.children ?? []) flattenTree(child, resolvedRoot, files, directories);
}

function sourcePathForSidecar(metaPath: string, source: unknown): string {
  const metaSource = typeof source === 'string' && source.trim() !== '' ? normalize(source) : '';
  const baseDir = metaPath.replace(/\/[^/]+$/, '');
  const candidate = metaSource.includes('/') ? metaSource : joinPath(baseDir, metaSource);
  return candidate || metaPath.replace(/\.meta\.json$/, '');
}

function diagnosticsForError(
  code: AssetBrowserDiagnostic['code'],
  path: string,
  err: unknown,
): AssetBrowserDiagnostic {
  return {
    code,
    path,
    message: (err as Error)?.message ?? String(err),
  };
}

type CatalogRow = AssetBrowserRegistryEntry | CatalogEntry;

function projectCatalogEntry(
  row: CatalogRow,
  roots: readonly AssetBrowserCatalogRoot[],
): AssetBrowserAsset {
  const guid = row.guid.toLowerCase();
  const sourcePath = row.sourcePath === undefined ? undefined : projectCatalogPath(row.sourcePath, roots);
  const rowRelations = row.relations as readonly (ProducerAssetRelation | AssetBrowserCatalogRelation)[] | undefined;
  const engineRelations = rowRelations?.filter(isProducerRelation) ?? [];
  const browserRelations = rowRelations?.filter(isBrowserRelation) ?? [];
  const relations = browserRelations.length > 0
    ? browserRelations
    : engineRelations.map(producerRelationToBrowserRelation);
  const catalogRevision = ('catalogRevision' in row ? row.catalogRevision : undefined)
    ?? (typeof row.revision === 'object' ? row.revision : undefined);
  const revision = typeof row.revision === 'string'
    ? row.revision
    : row.revision?.digest ?? (row.revision === undefined ? undefined : String(row.revision.observedAt));
  return {
    guid,
    kind: row.kind,
    name: row.name ?? guid.slice(0, 8),
    packageUrl: projectCatalogPath(row.packageUrl, roots),
    storagePackageUrl: row.packageUrl,
    ...(sourcePath ? { sourcePath } : {}),
    ...(row.sourceKey === undefined ? {} : { sourceKey: row.sourceKey }),
    ...(revision === undefined ? {} : { revision }),
    ...(catalogRevision === undefined ? {} : { catalogRevision }),
    ...(row.sourcePath ? { storageSourcePath: row.sourcePath } : {}),
    ...(row.packageId === undefined ? {} : { packageId: row.packageId }),
    ...(row.provenance === undefined ? {} : { provenance: row.provenance }),
    ...(row.sourceIndex === undefined ? {} : { sourceIndex: row.sourceIndex }),
    ...(row.sourceOverrides === undefined ? {} : { sourceOverrides: row.sourceOverrides }),
    ...(row.sourceOverrideDescriptors === undefined ? {} : { sourceOverrideDescriptors: row.sourceOverrideDescriptors }),
    ...(row.diagnostics === undefined ? {} : { diagnostics: row.diagnostics }),
    ...(row.cookReceiptUrl === undefined ? {} : { cookReceiptUrl: row.cookReceiptUrl }),
    ...(row.subject === undefined ? {} : { subject: row.subject }),
    ...(row.execution === undefined ? {} : { execution: row.execution }),
    ...(row.lifecycle === undefined ? {} : { lifecycle: row.lifecycle }),
    ...(row.projection === undefined ? {} : { projection: row.projection }),
    refs: [...(row.refs ?? [])],
    relations: Object.freeze(relations.length > 0
      ? relations
      : (row.refs ?? []).map((ref) => ({ kind: 'depends-on' as const, from: guid, to: ref }))),
    ...(engineRelations.length > 0 ? { catalogRelations: Object.freeze(engineRelations) } : {}),
    ...(row.authoring !== undefined ? { authoring: row.authoring } : {}),
  };
}

function catalogDiagnosticsToBrowser(
  diagnostics: readonly CatalogDiagnostic[],
): AssetBrowserDiagnostic[] {
  return diagnostics.map((detail) => ({
    code: 'CATALOG_DIAGNOSTIC' as const,
    message: detail.hint ?? detail.code,
    detail,
  }));
}

export function createAssetBrowserReadModel(deps: CreateAssetBrowserReadModelDeps): AssetBrowserReadModel {
  const workspace = createAssetWorkspace();
  let current: AssetBrowserSnapshot = {
    generation: 0,
    files: [],
    directories: [],
    assets: [],
    sources: [],
    diagnostics: [],
  };
  let nextGeneration = 0;
  let latestGeneration = 0;
  let catalogVersion = 0;
  let catalogStale = false;
  let catalogDiagnostics: readonly CatalogDiagnostic[] = [];
  let pendingDeltas: CatalogDelta[] = [];
  const listeners = new Set<(snapshot: AssetBrowserSnapshot) => void>();

  const publish = (snapshot: AssetBrowserSnapshot): void => {
    current = snapshot;
    for (const listener of listeners) listener(snapshot);
  };

  const currentCatalog = (): AssetBrowserCatalogSnapshot | undefined => deps.registry.catalogSnapshot?.();

  const readCatalogRows = (): readonly CatalogRow[] => {
    const catalog = currentCatalog();
    if (catalog === undefined) return deps.registry.listCatalog();
    return catalog.entries.map(enrichCatalogEntry);
  };

  // CatalogReplica is the revision/staleness stream, while listCatalog is the
  // registry's lossless producer projection. During source recovery the
  // replica can publish a lifecycle row before the registry's pack-index cache
  // has folded the retained LKG into that row. Fill only the missing LKG fact;
  // never replace the replica's locator or lifecycle.
  const enrichCatalogEntry = (entry: CatalogEntry): CatalogEntry => {
    if (entry.projection === undefined || entry.projection.lastKnownGood !== undefined) return entry;
    const live = deps.registry.listCatalog().find((candidate) => candidate.guid.toLowerCase() === entry.guid.toLowerCase());
    if (live?.projection?.lastKnownGood === undefined) return entry;
    return {
      ...entry,
      projection: {
        ...entry.projection,
        lastKnownGood: live.projection.lastKnownGood,
      },
    };
  };

  const catalogState = (): Pick<AssetBrowserSnapshot, 'catalogVersion' | 'catalogStale' | 'catalogDiagnostics' | 'reconcileRequired'> => {
    const catalog = currentCatalog();
    const stale = catalog?.stale ?? catalogStale;
    const diagnostics = catalog?.diagnostics ?? catalogDiagnostics;
    return {
      ...(catalog?.version === undefined ? (catalogVersion === 0 ? {} : { catalogVersion }) : { catalogVersion: catalog.version }),
      ...(stale ? { catalogStale: true, reconcileRequired: true } : { catalogStale: false, reconcileRequired: false }),
      catalogDiagnostics: diagnostics,
    };
  };

  const projectWorkspace = (assets: readonly AssetBrowserAsset[], generation: number, issues: readonly AssetBrowserDiagnostic[]) => workspace.reconcile({
    resourceRevision: `browser:${generation}`,
    logicalCommitId: `browser-catalog:${generation}`,
    subjects: assets.map((asset) => ({
      id: asset.guid,
      kind: 'imported-output' as const,
      provenance: { owner: 'engine' as const, source: 'asset-producer', packageId: asset.storagePackageUrl },
      resourceId: asset.storagePackageUrl,
      path: asset.packageUrl,
      capabilities: { canImport: false, canMove: true, canDelete: true, canPreflight: true },
      name: asset.name,
    })),
    relations: assets.flatMap((asset) => asset.relations.map((relation) => ({
      kind: relation.kind,
      from: relation.from,
      to: relation.to,
    }))),
    issues: issues.map<AssetWorkspaceIssue>((diagnostic) => ({
      code: 'malformed-package',
      severity: 'warning',
      message: diagnostic.message,
    })),
  }).snapshot;

  const applyCatalogDelta = (delta: CatalogDelta): void => {
    const hasGap = delta.authority === 'degraded' || delta.revisions?.current.some((point) => {
      const baseline = delta.revisions?.baseline.find((candidate) => candidate.rootId === point.rootId)?.revision ?? point.revision;
      return baseline + 1 < point.revision;
    }) === true;
    catalogStale = catalogStale || hasGap;
    catalogDiagnostics = [...catalogDiagnostics, ...(delta.diagnostics ?? [])].filter((diagnostic, index, all) =>
      all.findIndex((candidate) => candidate.code === diagnostic.code) === index);
    if (hasGap) {
      publish(Object.freeze({
        ...current,
        catalogStale: true,
        catalogDiagnostics,
        reconcileRequired: true,
        diagnostics: Object.freeze([
          ...current.diagnostics,
          ...catalogDiagnosticsToBrowser(delta.diagnostics ?? []),
          { code: 'CATALOG_STALE' as const, message: 'Catalog reconciliation is required.' },
        ]),
      }));
      return;
    }

    const byGuid = new Map(current.assets.map((asset) => [asset.guid, asset]));
    for (const entry of [...delta.added, ...delta.changed]) {
      const key = entry.guid.toLowerCase();
      const previous = byGuid.get(key);
      if (previous !== undefined && previous.catalogRevision?.observedAt !== undefined
        && entry.revision?.observedAt !== undefined && entry.revision.observedAt < previous.catalogRevision.observedAt) continue;
      byGuid.set(key, projectCatalogEntry(enrichCatalogEntry(entry), deps.catalogRoots));
    }
    for (const guid of delta.removed) byGuid.delete(guid.toLowerCase());
    const assets = current.assets.map((asset) => byGuid.get(asset.guid) ?? asset).filter((asset): asset is AssetBrowserAsset => asset !== undefined);
    for (const asset of byGuid.values()) if (!current.assets.some((currentAsset) => currentAsset.guid === asset.guid)) assets.push(asset);
    catalogVersion += 1;
    const nextDiagnostics = Object.freeze([...current.diagnostics, ...catalogDiagnosticsToBrowser(delta.diagnostics ?? [])]);
    const workspaceSnapshot = projectWorkspace(assets, current.generation, nextDiagnostics);
    publish(Object.freeze({
      ...current,
      assets: Object.freeze(assets),
      diagnostics: nextDiagnostics,
      workspace: workspaceSnapshot,
      catalogVersion,
      catalogStale: false,
      catalogDiagnostics,
      reconcileRequired: false,
    }));
  };

  if (deps.registry.subscribeCatalog) {
    deps.registry.subscribeCatalog((delta) => {
      if (current.generation === 0) pendingDeltas.push(delta);
      else applyCatalogDelta(delta);
    });
  }

  const readTree = async (): Promise<{ tree: AssetBrowserTreeNode | null; diagnostics: AssetBrowserDiagnostic[] }> => {
    try {
      const rootPath = deps.resolveGamePath('');
      const response = await deps.fetch(`/api/files/tree?root=${encodeURIComponent(rootPath)}&optional=1`, { cache: 'no-store' });
      if (!response.ok) {
        return { tree: null, diagnostics: [diagnosticsForError('TREE_READ_FAILED', rootPath, `HTTP ${response.status}`)] };
      }
      const body = await response.json() as { tree?: AssetBrowserTreeNode | null };
      return { tree: body.tree ?? null, diagnostics: [] };
    } catch (err) {
      return { tree: null, diagnostics: [diagnosticsForError('TREE_READ_FAILED', '', err)] };
    }
  };

  const refresh = async (hint?: 'directory-only' | 'pack-changed'): Promise<AssetBrowserSnapshot> => {
    const generation = ++nextGeneration;
    latestGeneration = generation;
    const treePromise = readTree();
    const hasImmutableCatalog = deps.registry.catalogSnapshot !== undefined;
    const catalogPromise = hint === 'directory-only' || hasImmutableCatalog
      ? Promise.resolve<readonly CatalogRow[]>(readCatalogRows())
      : (deps.registry.refreshCatalog ? deps.registry.refreshCatalog().catch(() => false).then(() => readCatalogRows()) : Promise.resolve(readCatalogRows()));
    const [{ tree, diagnostics }, catalogRows] = await Promise.all([treePromise, catalogPromise]);

    const files: AssetBrowserFile[] = [];
    const directories: AssetBrowserDirectory[] = [];
    if (tree) flattenTree(tree, deps.resolveGamePath(''), files, directories);
    files.sort((a, b) => a.path.localeCompare(b.path));
    directories.sort((a, b) => a.path.localeCompare(b.path));

    const assets: AssetBrowserAsset[] = [];
    const seenGuids = new Set<string>();
    const catalogBySource = new Map<string, string[]>();
    for (const row of catalogRows) {
      const guid = row.guid.toLowerCase();
      if (seenGuids.has(guid)) continue;
      seenGuids.add(guid);
      const asset = projectCatalogEntry(row, deps.catalogRoots);
      assets.push(asset);
      if (asset.sourcePath) catalogBySource.set(asset.sourcePath, [...(catalogBySource.get(asset.sourcePath) ?? []), guid]);
    }

    const sidecars: SidecarObservation[] = [];
    const sidecarDiagnostics: AssetBrowserDiagnostic[] = [];
    await Promise.all(files.filter((file) => file.path.endsWith('.meta.json')).map(async (file) => {
      try {
        const response = await deps.fetch(`/api/files/raw?path=${encodeURIComponent(file.diskPath)}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const json = await response.json() as { source?: unknown; revision?: unknown; subAssets?: unknown };
        if (!Array.isArray(json.subAssets)) throw new Error('meta sidecar subAssets must be an array');
        const subAssets = json.subAssets
          .map((entry) => {
            if (!entry || typeof entry !== 'object') return null;
            const value = entry as { guid?: unknown; kind?: unknown; sourceKey?: unknown };
            if (typeof value.guid !== 'string' || value.guid.length === 0) return null;
            return {
              guid: value.guid.toLowerCase(),
              ...(typeof value.kind === 'string' && value.kind.length > 0 ? { kind: value.kind } : {}),
              ...(typeof value.sourceKey === 'string' && value.sourceKey.length > 0 ? { sourceKey: value.sourceKey } : {}),
            };
          })
          .filter((entry): entry is { guid: string; kind?: string; sourceKey?: string } => entry !== null);
        const revision = typeof json.revision === 'string'
          ? json.revision
          : json.revision && typeof json.revision === 'object' && typeof (json.revision as { digest?: unknown }).digest === 'string'
            ? (json.revision as { digest: string }).digest
            : undefined;
        const sourceKeys = subAssets.flatMap((entry) => entry.sourceKey === undefined ? [] : [entry.sourceKey]);
        sidecars.push({
          sourcePath: sourcePathForSidecar(file.path, json.source),
          metaPath: file.path,
          subAssets,
          ...(revision === undefined ? {} : { metaRevision: revision }),
          sourceKeys,
        });
      } catch (err) {
        sidecarDiagnostics.push(diagnosticsForError('INVALID_META', file.path, err));
      }
    }));

    const sourcePaths = new Set<string>(catalogBySource.keys());
    // A source file is still observable before either its sidecar or registry
    // entry exists. Keep it as a raw source state; it is not an asset row.
    for (const file of files) {
      if (!file.path.endsWith('.meta.json')) sourcePaths.add(file.path);
    }
    for (const sidecar of sidecars) sourcePaths.add(sidecar.sourcePath);
    const sidecarBySource = new Map<string, SidecarObservation>();
    for (const sidecar of sidecars) sidecarBySource.set(sidecar.sourcePath, sidecar);
    for (const diagnostic of sidecarDiagnostics) sourcePaths.add(diagnostic.path?.replace(/\.meta\.json$/, '') ?? '');

    // UI authoring is meta-defined, and the runtime catalog may lag behind the
    // source tree during a dev refresh. Keep the sidecar's UI identity visible
    // in that interval instead of making the source look like an unindexed raw
    // document. Catalog rows remain authoritative when present; this only
    // materializes missing `kind: "ui"` rows.
    for (const sidecar of sidecars) {
      for (const subAsset of sidecar.subAssets) {
        if (subAsset.kind !== 'ui' || seenGuids.has(subAsset.guid)) continue;
        seenGuids.add(subAsset.guid);
        assets.push({
          guid: subAsset.guid,
          kind: 'ui',
          name: sidecar.sourcePath.split('/').pop()?.replace(/\.ui\.html$/i, '') ?? subAsset.guid.slice(0, 8),
          packageUrl: sidecar.metaPath,
          storagePackageUrl: sidecar.metaPath,
          sourcePath: sidecar.sourcePath,
          storageSourcePath: sidecar.sourcePath,
          refs: [],
          relations: [],
        });
        catalogBySource.set(sidecar.sourcePath, [...(catalogBySource.get(sidecar.sourcePath) ?? []), subAsset.guid]);
      }
    }

    const sources: AssetSourceState[] = [];
    for (const sourcePath of sourcePaths) {
      if (!sourcePath) continue;
      const sidecar = sidecarBySource.get(sourcePath);
      const catalogGuids = catalogBySource.get(sourcePath) ?? [];
      const invalidMeta = sidecarDiagnostics.some((diagnostic) => diagnostic.path === `${sourcePath}.meta.json`);
      const observedMetaGuids = sidecar?.subAssets.map((entry) => entry.guid) ?? [];
      const phase: AssetSourcePhase = invalidMeta
        ? 'invalid-meta'
        : catalogGuids.length > 0
          ? 'indexed'
          : sidecar?.subAssets.length
            ? 'pending-index'
            : 'raw';
      sources.push({
        sourcePath,
        ...(sidecar ? { metaPath: sidecar.metaPath } : {}),
        phase,
        catalogGuids,
        observedMetaGuids,
        ...(sidecar?.metaRevision === undefined ? {} : { metaRevision: sidecar.metaRevision }),
        sourceKeys: sidecar?.sourceKeys ?? [],
      });
    }
    sources.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
    const enrichedAssets = assets.map((asset) => {
      if (asset.sourcePath === undefined) return asset;
      const metaPath = sidecarBySource.get(asset.sourcePath)?.metaPath;
      const sidecar = sidecarBySource.get(asset.sourcePath);
      return metaPath === undefined
        ? asset
        : {
          ...asset,
          metaPath,
          ...(sidecar?.metaRevision === undefined ? {} : { metaRevision: sidecar.metaRevision }),
        };
    });

    const allDiagnostics = Object.freeze([
      ...diagnostics,
      ...sidecarDiagnostics,
      ...catalogDiagnosticsToBrowser(currentCatalog()?.diagnostics ?? catalogDiagnostics),
      ...(currentCatalog()?.stale === true ? [{ code: 'CATALOG_STALE' as const, message: 'Catalog reconciliation is required.' }] : []),
    ]);
    const workspaceResult = projectWorkspace(enrichedAssets, generation, allDiagnostics);
    const catalog = currentCatalog();
    catalogVersion = catalog?.version ?? catalogVersion;
    catalogStale = catalog?.stale ?? catalogStale;
    catalogDiagnostics = catalog?.diagnostics ?? catalogDiagnostics;
    const snapshot: AssetBrowserSnapshot = Object.freeze({
      generation,
      files: Object.freeze(files),
      directories: Object.freeze(directories),
      assets: Object.freeze(enrichedAssets),
      sources: Object.freeze(sources),
      diagnostics: allDiagnostics,
      workspace: workspaceResult,
      ...catalogState(),
    });
    if (generation === latestGeneration) publish(snapshot);
    if (generation === latestGeneration && pendingDeltas.length > 0) {
      const queued = pendingDeltas;
      pendingDeltas = [];
      for (const delta of queued) applyCatalogDelta(delta);
    }
    return generation === latestGeneration ? snapshot : current;
  };

  const reconcile = async (): Promise<AssetBrowserSnapshot> => {
    if (deps.registry.reconcileCatalog) await deps.registry.reconcileCatalog();
    else if (deps.registry.refreshCatalog) await deps.registry.refreshCatalog().catch(() => false);
    catalogStale = false;
    catalogDiagnostics = [];
    return refresh('directory-only');
  };

  return {
    snapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    reconcile,
  };
}
