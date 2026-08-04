import {
  assetIO,
  createCatalogReconcileProvider,
  gateway,
  type AssetBrowserAsset,
  type AssetBrowserCatalogRelation,
  type ActiveSceneSourceReference,
  type SourceAuthoringRuntime,
  type SourceMutationPreflightInput,
  type EditorOp,
  hasPathResolver,
  resolveGamePath,
  worldEntityHandles,
} from '@forgeax/editor-core';
import { SceneInstance } from '@forgeax/engine-render';
import type { SourceOverrideDescriptor } from '@forgeax/engine-types';
import { observeSourcePublication } from '../viewport/viewport-runtime-bridges';

type EngineCatalogReconcileProvider = Parameters<typeof createCatalogReconcileProvider>[0];

export interface SourceCatalogRow {
  readonly guid: string;
  readonly kind: string;
  readonly name?: string;
  readonly packageUrl: string;
  readonly sourcePath?: string;
  readonly sourceKey?: string;
  readonly revision?: unknown;
  readonly refs?: readonly string[];
  readonly relations?: readonly { readonly type?: unknown; readonly from?: unknown; readonly to?: unknown }[];
  readonly sourceOverrideDescriptors?: readonly SourceOverrideDescriptor[];
}

interface MetaSubAsset {
  readonly guid?: unknown;
  readonly sourceKey?: unknown;
}

export interface SourceAuthoringRuntimeDependencies {
  readonly catalog: () => readonly SourceCatalogRow[];
  readonly readMetaSidecar: (metaPath: string) => ReturnType<typeof assetIO.readMetaSidecar>;
  readonly triggerCook: (guid: string, signal?: AbortSignal) => ReturnType<typeof assetIO.triggerCook>;
  readonly activeSceneReferences: () => readonly ActiveSceneSourceReference[];
  readonly observePublication: NonNullable<SourceAuthoringRuntime['observePublication']>;
}

function activeSceneReferencesFromGateway(): readonly ActiveSceneSourceReference[] {
  const world = gateway.doc.world;
  if (world === undefined) return [];
  const references: ActiveSceneSourceReference[] = [];
  for (const instanceEntity of worldEntityHandles(world)) {
    const result = world.get(instanceEntity, SceneInstance);
    if (!result.ok) continue;
    const source = result.value.source;
    const summary = gateway.describeAsset(source);
    if (!summary.ok || typeof summary.guid !== 'string') continue;
    references.push({ assetGuid: summary.guid, instanceGuid: String(instanceEntity) });
  }
  return references.sort((left, right) => {
    const assetOrder = left.assetGuid.localeCompare(right.assetGuid);
    return assetOrder !== 0 ? assetOrder : left.instanceGuid.localeCompare(right.instanceGuid);
  });
}

function revisionText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null || typeof value !== 'object') return undefined;
  const digest = (value as { readonly digest?: unknown }).digest;
  return typeof digest === 'string' ? digest : undefined;
}

function metaPathFor(row: SourceCatalogRow): string {
  if (typeof row.sourcePath !== 'string' || row.sourcePath.trim() === '') {
    throw new Error(`Catalog row ${row.guid} has no producer-owned sourcePath for Meta lookup`);
  }
  const catalogSourcePath = row.sourcePath.replace(/\\/g, '/');
  const relativeSourcePath = hasPathResolver()
    ? (() => {
      const root = resolveGamePath('').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      const marker = `/${root}/`;
      const markerIndex = catalogSourcePath.lastIndexOf(marker);
      if (markerIndex >= 0) return catalogSourcePath.slice(markerIndex + marker.length);
      return catalogSourcePath.startsWith(`${root}/`) ? catalogSourcePath.slice(root.length + 1) : catalogSourcePath;
    })()
    : catalogSourcePath;
  const relative = relativeSourcePath.endsWith('.meta.json') ? relativeSourcePath : `${relativeSourcePath}.meta.json`;
  if (!hasPathResolver()) return relative;
  const root = resolveGamePath('');
  return relative === root || relative.startsWith(`${root}/`) ? relative : resolveGamePath(relative);
}

function relationFacts(row: SourceCatalogRow): readonly AssetBrowserCatalogRelation[] {
  const explicit = (row.relations ?? []).flatMap((relation) => {
    if (relation.type !== 'depends-on' && relation.type !== 'referenced-by' && relation.type !== 'contains' && relation.type !== 'derived-from') return [];
    if (typeof relation.from !== 'string' || typeof relation.to !== 'string') return [];
    const kind: AssetBrowserCatalogRelation['kind'] = relation.type;
    return [{ kind, from: relation.from, to: relation.to }];
  });
  if (explicit.length > 0) return explicit;
  return (row.refs ?? []).map((to) => ({ kind: 'depends-on' as const, from: row.guid, to }));
}

function browserAsset(row: SourceCatalogRow): AssetBrowserAsset {
  const revision = revisionText(row.revision);
  return {
    guid: row.guid,
    kind: row.kind,
    name: row.name ?? row.guid,
    packageUrl: row.packageUrl,
    storagePackageUrl: row.packageUrl,
    ...(row.sourcePath === undefined ? {} : { sourcePath: row.sourcePath, storageSourcePath: row.sourcePath }),
    ...(row.sourceKey === undefined ? {} : { sourceKey: row.sourceKey }),
    ...(revision === undefined ? {} : { revision }),
    refs: [...(row.refs ?? [])],
    relations: relationFacts(row),
  };
}

function sourceRow(rows: readonly SourceCatalogRow[], op: EditorOp): SourceCatalogRow {
  const guid = (op as { readonly guid?: unknown }).guid;
  if (typeof guid !== 'string') throw new Error('source operation has no GUID');
  const row = rows.find((candidate) => candidate.guid.toLowerCase() === guid.toLowerCase());
  if (row === undefined) throw new Error(`Catalog row ${guid} is not available for source authoring`);
  return row;
}

async function readPreflightInput(deps: SourceAuthoringRuntimeDependencies, op: EditorOp): Promise<SourceMutationPreflightInput> {
  const rows = deps.catalog();
  const row = sourceRow(rows, op);
  const snapshot = await deps.readMetaSidecar(metaPathFor(row));
  if (!snapshot.ok) {
    const error = new Error(snapshot.error.hint) as Error & { readonly code?: string };
    Object.defineProperty(error, 'code', { value: 'asset-meta-read-failed' });
    throw error;
  }
  let subAssets: MetaSubAsset[];
  try {
    const parsed = JSON.parse(snapshot.value.contents) as { readonly subAssets?: unknown };
    subAssets = Array.isArray(parsed.subAssets) ? parsed.subAssets as MetaSubAsset[] : [];
  } catch {
    const error = new Error('source Meta sidecar is not valid JSON') as Error & { readonly code?: string };
    Object.defineProperty(error, 'code', { value: 'asset-meta-invalid' });
    throw error;
  }
  const outputs = subAssets.flatMap((entry) => {
    if (typeof entry.guid !== 'string' || typeof entry.sourceKey !== 'string') return [];
    return [{ guid: entry.guid, sourceKey: entry.sourceKey }];
  });
  if (outputs.length === 0) throw new Error('source Meta sidecar has no producer-owned sub-assets');
  const assets = rows.map(browserAsset);
  return {
    browser: {
      assets,
      relations: assets.flatMap((asset) => asset.relations),
    },
    meta: {
      metaRevision: snapshot.value.revision,
      subAssets: outputs,
      sourceOverrideDescriptors: [...new Map(
        rows.flatMap((catalogRow) => catalogRow.sourceOverrideDescriptors ?? [])
          .map((descriptor) => [descriptor.sourceKey, descriptor] as const),
      ).values()],
    },
    activeSceneReferences: deps.activeSceneReferences(),
  };
}

/** Bind canonical catalog.reconcile to the live Engine public contract; this reads no Meta. */
export function installCatalogReconcileProvider(registry: EngineCatalogReconcileProvider): () => void {
  return gateway.registerCatalogReconcile(createCatalogReconcileProvider(registry));
}

export function createSourceAuthoringRuntime(
  overrides: Partial<SourceAuthoringRuntimeDependencies> = {},
): SourceAuthoringRuntime {
  const deps: SourceAuthoringRuntimeDependencies = {
    catalog: () => gateway.assetCatalog() as readonly SourceCatalogRow[],
    readMetaSidecar: (metaPath) => assetIO.readMetaSidecar(metaPath),
    triggerCook: (guid, signal) => assetIO.triggerCook(guid, signal),
    activeSceneReferences: activeSceneReferencesFromGateway,
    observePublication: observeSourcePublication,
    ...overrides,
  };
  return {
    getPreflightInput: (op) => readPreflightInput(deps, op),
    metaPath: (op) => metaPathFor(sourceRow(deps.catalog(), op)),
    rebuild: async ({ op, signal }) => {
      const guid = (op as { readonly guid: string }).guid;
      const cooked = await deps.triggerCook(guid, signal);
      if (cooked.ok) return cooked.value;
      const error = new Error(cooked.error.hint) as Error & { readonly code?: string };
      Object.defineProperty(error, 'code', { value: 'asset-cook-failed' });
      throw error;
    },
    observePublication: deps.observePublication,
  };
}
