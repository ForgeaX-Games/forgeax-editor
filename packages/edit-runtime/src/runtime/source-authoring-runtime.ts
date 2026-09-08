import {
  assetIO,
  createCatalogReconcileProvider,
  gateway,
  type AssetBrowserAsset,
  type AssetBrowserCatalogRelation,
  type ActiveSceneSourceReference,
  type SourceAuthoringOperationDescriptor,
  type SourceAuthoringRuntimeResult,
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
  readonly sourceOverrides?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly relations?: readonly { readonly type?: unknown; readonly from?: unknown; readonly to?: unknown }[];
  readonly sourceOverrideDescriptors?: readonly SourceOverrideDescriptor[];
}

export interface SourceAuthoringProducerPreflight {
  readonly sourcePath: string;
  readonly revision: string;
  readonly meta: unknown;
}

interface MetaSubAsset {
  readonly guid?: unknown;
  readonly sourceKey?: unknown;
}

function validationFailure(hint: string): never {
  const error = new Error(hint) as Error & { readonly code?: string; readonly retryable?: boolean };
  Object.defineProperties(error, {
    code: { value: 'asset-validation-failed' },
    retryable: { value: false },
  });
  throw error;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function producerFacts(value: Record<string, unknown>): Record<string, unknown> {
  const { materialSlotDefaultOverrides: _authored, ...producerOwned } = value;
  return producerOwned;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function jsonFactsEqual(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function validateMeshMaterialSlotOverride(rows: readonly SourceCatalogRow[], op: EditorOp): void {
  const command = op as { readonly guid?: unknown; readonly scope?: { readonly sourceKey?: unknown }; readonly override?: unknown };
  if (typeof command.guid !== 'string' || typeof command.scope?.sourceKey !== 'string') return;
  const guid = command.guid;
  const sourceKey = command.scope.sourceKey;
  const row = rows.find((entry) => entry.guid.toLowerCase() === guid.toLowerCase());
  const descriptor = row?.sourceOverrideDescriptors?.find((candidate) => (
    candidate.sourceKey === sourceKey
    && candidate.semantic === 'mesh-material-slot-defaults'
  ));
  if (descriptor === undefined) return;
  if (row?.kind !== 'mesh') validationFailure('Mesh material-slot defaults can only target a catalogued Mesh output.');
  const previous = record(row.sourceOverrides?.[sourceKey]);
  const next = record(command.override);
  if (previous === undefined || next === undefined) validationFailure('Mesh material-slot defaults require a producer-owned override object.');
  if (!jsonFactsEqual(producerFacts(previous), producerFacts(next))) {
    validationFailure('Mesh material-slot authoring may only change materialSlotDefaultOverrides; producer-owned topology is immutable.');
  }
  const slots = Array.isArray(previous.materialSlots) ? previous.materialSlots : [];
  const activeKeys = new Set(slots.flatMap((value) => {
    const slot = record(value);
    if (slot === undefined || slot.tombstone === true) return [];
    const key = typeof slot.sourceKey === 'string' ? slot.sourceKey : slot.slotName;
    return typeof key === 'string' && key.length > 0 ? [key] : [];
  }));
  const before = record(previous.materialSlotDefaultOverrides) ?? {};
  const after = record(next.materialSlotDefaultOverrides) ?? {};
  const changedKeys = new Set([...Object.keys(before), ...Object.keys(after)].filter(
    (key) => before[key] !== after[key],
  ));
  for (const key of changedKeys) {
    if (!activeKeys.has(key)) validationFailure(`Material slot identity "${key}" is absent or removed in the current Mesh topology.`);
    const materialGuid = after[key];
    if (materialGuid === undefined || materialGuid === null) continue;
    if (typeof materialGuid !== 'string') validationFailure(`Material slot "${key}" must contain a material GUID, null, or no override.`);
    const material = rows.find((entry) => entry.guid.toLowerCase() === materialGuid.toLowerCase());
    if (material?.kind !== 'material') validationFailure(`Material slot "${key}" references a GUID that is not a catalogued MaterialAsset.`);
  }
}

export interface SourceAuthoringRuntimeDependencies {
  readonly catalog: () => readonly SourceCatalogRow[];
  readonly readMetaSidecar: (metaPath: string) => ReturnType<typeof assetIO.readMetaSidecar>;
  readonly triggerCook: (guid: string, signal?: AbortSignal) => ReturnType<typeof assetIO.triggerCook>;
  readonly activeSceneReferences: () => readonly ActiveSceneSourceReference[];
  readonly observePublication: NonNullable<SourceAuthoringRuntime['observePublication']>;
  readonly preflightSource?: (input: {
    readonly sourcePath: string;
    readonly requestId: string;
  }) => Promise<SourceAuthoringProducerPreflight>;
  readonly structuredOperations?: readonly SourceAuthoringOperationDescriptor[];
  readonly executeStructured?: (op: EditorOp) => Promise<SourceAuthoringRuntimeResult>;
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

function isProducerSource(row: SourceCatalogRow): boolean {
  return row.sourcePath?.replace(/\\/g, '/').toLowerCase().endsWith('.pack.ts') === true;
}

function sourceOutputs(meta: unknown, sourceLabel: string): readonly { readonly guid: string; readonly sourceKey: string }[] {
  const parsed = record(meta);
  const subAssets = parsed?.subAssets;
  if (!Array.isArray(subAssets)) throw new Error(`${sourceLabel} Meta has no producer-owned sub-assets`);
  const outputs = subAssets.flatMap((entry) => {
    const value = record(entry);
    if (typeof value?.guid !== 'string' || typeof value.sourceKey !== 'string') return [];
    return [{ guid: value.guid, sourceKey: value.sourceKey }];
  });
  if (outputs.length === 0) throw new Error(`${sourceLabel} Meta has no producer-owned sub-assets`);
  return outputs;
}

function sourceOverrideDescriptors(rows: readonly SourceCatalogRow[]): readonly SourceOverrideDescriptor[] {
  return [...new Map(
    rows.flatMap((catalogRow) => catalogRow.sourceOverrideDescriptors ?? [])
      .map((descriptor) => [descriptor.sourceKey, descriptor] as const),
  ).values()];
}

function preflightInput(
  rows: readonly SourceCatalogRow[],
  revision: string,
  outputs: readonly { readonly guid: string; readonly sourceKey: string }[],
  activeSceneReferences: readonly ActiveSceneSourceReference[],
): SourceMutationPreflightInput {
  const assets = rows.map(browserAsset);
  return {
    browser: {
      assets,
      relations: assets.flatMap((asset) => asset.relations),
    },
    meta: {
      metaRevision: revision,
      subAssets: outputs,
      sourceOverrideDescriptors: sourceOverrideDescriptors(rows),
    },
    activeSceneReferences,
  };
}

async function readPreflightInput(deps: SourceAuthoringRuntimeDependencies, op: EditorOp): Promise<SourceMutationPreflightInput> {
  const rows = deps.catalog();
  const row = sourceRow(rows, op);
  if (isProducerSource(row) && op.kind === 'asset.preflight') {
    const requestId = (op as { readonly requestId?: unknown }).requestId;
    if (deps.preflightSource === undefined) {
      throw new Error(`No producer preflight is available for ${row.sourcePath}`);
    }
    if (typeof row.sourcePath !== 'string' || typeof requestId !== 'string') {
      throw new Error('producer preflight requires a sourcePath and requestId');
    }
    const producer = await deps.preflightSource({ sourcePath: row.sourcePath, requestId });
    if (producer.sourcePath !== row.sourcePath) {
      throw new Error(`Producer preflight returned ${producer.sourcePath} for ${row.sourcePath}`);
    }
    return preflightInput(
      rows,
      producer.revision,
      sourceOutputs(producer.meta, row.sourcePath),
      deps.activeSceneReferences(),
    );
  }
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
  return preflightInput(rows, snapshot.value.revision, outputs, deps.activeSceneReferences());
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
    validateSourceOverride: (op) => validateMeshMaterialSlotOverride(deps.catalog(), op),
    ...(deps.structuredOperations === undefined ? {} : { structuredOperations: deps.structuredOperations }),
    ...(deps.executeStructured === undefined ? {} : { executeStructured: deps.executeStructured }),
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
