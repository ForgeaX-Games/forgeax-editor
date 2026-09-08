import {
  authoringCapabilityForAssetKind,
  type AssetAuthoringCapability,
  type AssetPublicationEnvelope,
  type AssetPublicationExternalEvidence,
  type AssetPublicationLocator,
  type AssetPublicationOutput,
  type CatalogEntry,
} from '@forgeax/engine-types';

export type ScriptablePackReadModelStatus = 'unpublished' | 'current' | 'failed';

export type ScriptablePackEvidenceUsage = 'referenced' | 'content-read' | 'both';

export type ScriptablePackDependencyStatus = 'ready' | 'missing' | 'invalid' | 'unloaded' | 'stale';

export interface ScriptablePackExternalEvidence extends Omit<AssetPublicationExternalEvidence, 'usage'> {
  readonly usage: ScriptablePackEvidenceUsage;
}

export interface ScriptablePackDependencyProjection {
  readonly guid: string;
  readonly usage?: ScriptablePackEvidenceUsage;
  readonly status: ScriptablePackDependencyStatus;
  readonly generation?: number;
  readonly digest?: string;
  readonly diagnostic?: ScriptablePackReadModelFailure;
}

export interface ScriptablePackReadModelFailure {
  readonly code: string;
  readonly stage: string;
  readonly sourcePath: string;
  readonly outputGuid?: string;
  readonly expected?: string;
  readonly actual?: string;
  readonly reason: string;
  readonly recoveryActions: readonly string[];
}

export interface ScriptablePackOutputReadModel {
  readonly guid: string;
  readonly sourceKey: string;
  readonly kind: string;
  readonly digest: string;
  readonly refs: readonly string[];
  readonly sourcePath: string;
  readonly packageUrl: string;
  readonly capabilities: AssetAuthoringCapability;
  readonly catalogEntry: CatalogEntry;
}

export interface ScriptablePackSourceReadModel {
  readonly kind: 'asset-pack';
  readonly path: string;
  readonly sourceRevision: string;
  readonly outputs: readonly string[];
}

export interface ScriptablePackReadModel {
  readonly status: ScriptablePackReadModelStatus;
  readonly source: ScriptablePackSourceReadModel;
  readonly outputs: readonly ScriptablePackOutputReadModel[];
  /** Complete publication tuple when the source has been published. */
  readonly publication?: AssetPublicationEnvelope;
  readonly sourceRevision: string;
  readonly generation: number;
  readonly digest: string;
  readonly outputSetDigest: string;
  readonly receipt?: AssetPublicationEnvelope['receipt'];
  readonly externalEvidence: readonly ScriptablePackExternalEvidence[];
  readonly dependencies: readonly ScriptablePackDependencyProjection[];
  readonly current?: AssetPublicationLocator;
  readonly lastKnownGood?: AssetPublicationLocator;
  readonly failure?: ScriptablePackReadModelFailure;
  readonly diagnostics: readonly ScriptablePackReadModelFailure[];
}

export interface ScriptablePackReadModelInput {
  readonly sourcePath?: string;
  readonly publication?: AssetPublicationEnvelope;
  readonly catalogEntries: readonly CatalogEntry[];
}

const recoveryFor = (publication: AssetPublicationEnvelope): readonly string[] => (
  publication.recovery?.actions ?? ['run.retry', 'catalog.reconcile']
);

function failure(
  publication: AssetPublicationEnvelope,
  input: Pick<ScriptablePackReadModelFailure, 'code' | 'stage' | 'reason'> & Partial<Pick<ScriptablePackReadModelFailure, 'outputGuid' | 'expected' | 'actual'>>,
): ScriptablePackReadModelFailure {
  return {
    sourcePath: publication.sourcePath,
    recoveryActions: recoveryFor(publication),
    ...input,
  };
}

function evidenceUsage(value: unknown): ScriptablePackEvidenceUsage | undefined {
  if (value === 'reference') return 'referenced';
  if (value === 'content') return 'content-read';
  if (value === 'both') return 'both';
  return undefined;
}

function projectEvidence(
  values: readonly AssetPublicationExternalEvidence[],
): readonly ScriptablePackExternalEvidence[] {
  return Object.freeze(values.flatMap((value) => {
    const usage = evidenceUsage(value.usage);
    return usage === undefined ? [] : [{ ...value, usage }];
  }));
}

function projectDependencies(
  publication: AssetPublicationEnvelope | undefined,
  catalogEntries: readonly CatalogEntry[],
): readonly ScriptablePackDependencyProjection[] {
  if (publication === undefined) return Object.freeze([]);
  const catalogByGuid = new Map(catalogEntries.map((entry) => [entry.guid.toLowerCase(), entry]));
  return Object.freeze(publication.externalEvidence.map((value) => {
    const usage = evidenceUsage(value.usage);
    let status: ScriptablePackDependencyStatus = 'ready';
    const entry = catalogByGuid.get(value.guid.toLowerCase());
    const dependencyPublication = entry?.publication;
    const dependencyOutput = dependencyPublication?.outputs.find(
      (output) => output.guid.toLowerCase() === value.guid.toLowerCase(),
    );
    if (usage === undefined) {
      status = 'invalid';
    } else if (entry === undefined) {
      status = 'missing';
    } else if (dependencyPublication === undefined) {
      status = 'unloaded';
    } else if (dependencyPublication.failure !== undefined || dependencyPublication.failureStage !== undefined) {
      status = 'invalid';
    } else if (dependencyOutput === undefined) {
      status = 'invalid';
    } else if (
      (value.generation !== undefined && dependencyPublication.generation !== value.generation)
      || (value.digest !== undefined && dependencyOutput.digest !== value.digest)
    ) {
      // Dependency evidence is provenance for the dependency publication, not
      // the parent Pack's generation. Compare it against the matched catalog
      // row/output tuple instead of the parent publication.
      status = 'stale';
    }
    const diagnostic = status === 'ready'
      ? undefined
      : failure(publication, {
        code: `asset-publication-dependency-${status}`,
        stage: 'receipt',
        outputGuid: value.guid,
        expected: value.generation === undefined && value.digest === undefined
          ? undefined
          : `${value.generation ?? 'any'}:${value.digest ?? 'any'}`,
        actual: dependencyPublication === undefined || dependencyOutput === undefined
          ? status
          : `${dependencyPublication.generation}:${dependencyOutput.digest}`,
        reason: `Dependency ${value.guid} has ${status} publication evidence`,
      });
    return {
      guid: value.guid,
      ...(usage === undefined ? {} : { usage }),
      status,
      ...(value.generation === undefined ? {} : { generation: value.generation }),
      ...(value.digest === undefined ? {} : { digest: value.digest }),
      ...(diagnostic === undefined ? {} : { diagnostic }),
    };
  }));
}

/** Stable field contract consumed by Browser, Inspector, and AI read clients. */
export const SCRIPTABLE_PACK_READ_MODEL_SCHEMA = Object.freeze({
  version: 'scriptable-pack-read-model/1',
  sourceFields: ['path', 'sourceRevision', 'outputs'],
  outputFields: ['guid', 'sourceKey', 'kind', 'digest', 'sourcePath', 'packageUrl', 'capabilities'],
  publicationFields: ['sourceRevision', 'generation', 'digest', 'outputSetDigest', 'receipt', 'current', 'lastKnownGood'],
  dependencyFields: ['guid', 'usage', 'status', 'generation', 'digest', 'diagnostic'],
  diagnosticFields: ['code', 'stage', 'sourcePath', 'outputGuid', 'expected', 'actual', 'reason', 'recoveryActions'],
  operations: ['asset.preflight', 'asset-source.create', 'asset-source.add-output', 'asset-source.add-external-asset', 'asset-source.rename', 'asset-source.remove-output', 'asset-source.clone', 'asset-source.rebuild', 'asset-source.cold-cook'],
  ordinaryOperations: ['addSceneAssetToScene', 'setDefaultScene', 'setSceneOverride', 'saveDocToDisk', 'play'],
} as const);

function outputMatchesCatalog(
  output: AssetPublicationOutput,
  entry: CatalogEntry | undefined,
  publication: AssetPublicationEnvelope,
): boolean {
  return entry !== undefined
    && entry.guid.toLowerCase() === output.guid.toLowerCase()
    && entry.sourcePath === publication.sourcePath
    && entry.sourceKey === output.sourceKey
    && entry.kind === output.kind
    && entry.publication?.generation === publication.generation
    && entry.publication.digest === publication.digest
    && entry.publication.outputSetDigest === publication.outputSetDigest;
}

function baseModel(input: ScriptablePackReadModelInput): Omit<ScriptablePackReadModel, 'outputs' | 'source' | 'status' | 'failure' | 'diagnostics'> {
  const { publication } = input;
  const sourcePath = input.sourcePath ?? publication?.sourcePath;
  if (sourcePath === undefined || sourcePath.trim() === '') {
    throw new Error('ScriptablePack read model requires sourcePath for an unpublished source.');
  }
  return {
    ...(publication === undefined ? {} : { publication }),
    sourceRevision: publication?.sourceRevision ?? '',
    generation: publication?.generation ?? 0,
    digest: publication?.digest ?? '',
    outputSetDigest: publication?.outputSetDigest ?? '',
    ...(publication === undefined ? {} : { receipt: publication.receipt }),
    externalEvidence: projectEvidence(publication?.externalEvidence ?? []),
    dependencies: projectDependencies(publication, input.catalogEntries),
    ...(publication?.current === undefined ? {} : { current: publication.current }),
    ...(publication?.lastKnownGood === undefined ? {} : { lastKnownGood: publication.lastKnownGood }),
  };
}

/**
 * Project one Engine publication and its Catalog rows into the shared Pack
 * read model. The projector never executes source or mutates Catalog/World.
 * A candidate publication is visible only when every output row belongs to
 * the same generation, digest, and output-set tuple.
 */
export function projectScriptablePackReadModel(
  input: ScriptablePackReadModelInput,
): ScriptablePackReadModel {
  const { publication } = input;
  const sourcePath = input.sourcePath ?? publication?.sourcePath;
  if (sourcePath === undefined || sourcePath.trim() === '') {
    throw new Error('ScriptablePack read model requires sourcePath for an unpublished source.');
  }
  const base = baseModel(input);
  const parent = (outputs: readonly string[]): ScriptablePackSourceReadModel => Object.freeze({
    kind: 'asset-pack',
    path: sourcePath,
    sourceRevision: publication?.sourceRevision ?? '',
    outputs: Object.freeze(outputs),
  });

  if (publication === undefined) {
    return Object.freeze({
      ...base,
      status: 'unpublished',
      source: parent([]),
      outputs: Object.freeze([]),
      diagnostics: Object.freeze([]),
    });
  }

  if (publication.failure !== undefined || publication.failureStage !== undefined) {
    const diagnostic = failure(publication, {
      code: publication.failure?.code ?? 'asset-publication-failed',
      stage: publication.failure?.stage ?? publication.failureStage ?? 'publication',
      outputGuid: publication.failure?.outputGuid,
      reason: publication.failure?.reason ?? 'publication did not produce a current generation',
    });
    return Object.freeze({
      ...base,
      status: 'failed',
      source: parent([]),
      outputs: Object.freeze([]),
      failure: diagnostic,
      diagnostics: Object.freeze([diagnostic]),
    });
  }

  const entriesByGuid = new Map(input.catalogEntries.map((entry) => [entry.guid.toLowerCase(), entry]));
  const missing = publication.outputs.find((output) => (
    !outputMatchesCatalog(output, entriesByGuid.get(output.guid.toLowerCase()), publication)
  ));
  if (missing !== undefined) {
    const entry = entriesByGuid.get(missing.guid.toLowerCase());
    const diagnostic = failure(publication, {
      code: 'asset-publication-catalog-incomplete',
      stage: 'catalog',
      outputGuid: missing.guid,
      expected: `${missing.sourceKey}:${missing.kind}@${publication.generation}`,
      actual: entry === undefined ? 'missing' : `${entry.sourceKey ?? 'missing-source-key'}:${entry.kind}@${entry.publication?.generation ?? 'missing-generation'}`,
      reason: `Catalog is missing the complete publication row for output ${missing.guid}`,
    });
    return Object.freeze({
      ...base,
      status: 'failed',
      source: parent([]),
      outputs: Object.freeze([]),
      failure: diagnostic,
      diagnostics: Object.freeze([diagnostic]),
    });
  }

  const outputs = [...publication.outputs]
    .sort((left, right) => left.sourceKey.localeCompare(right.sourceKey) || left.guid.localeCompare(right.guid))
    .map((output) => {
      const entry = entriesByGuid.get(output.guid.toLowerCase()) as CatalogEntry;
      return Object.freeze({
        guid: output.guid,
        sourceKey: output.sourceKey,
        kind: output.kind,
        digest: output.digest,
        refs: Object.freeze([...output.refs]),
        sourcePath,
        packageUrl: entry.packageUrl,
        capabilities: entry.authoring ?? authoringCapabilityForAssetKind(output.kind),
        catalogEntry: entry,
      });
    });
  const outputGuids = [...outputs].sort((left, right) => left.guid.localeCompare(right.guid)).map((output) => output.guid);
  const dependencyDiagnostics = base.dependencies.flatMap((dependency) => (
    dependency.diagnostic === undefined ? [] : [dependency.diagnostic]
  ));
  return Object.freeze({
    ...base,
    status: 'current',
    source: parent(outputGuids),
    outputs: Object.freeze(outputs),
    diagnostics: Object.freeze(dependencyDiagnostics),
  });
}
