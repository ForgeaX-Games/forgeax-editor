import type {
  AssetProvenance,
  AssetSubjectId,
} from '../contracts/asset-workspace';

export interface SourceMetaObservation {
  readonly sourcePath: string;
  readonly sourcePresent: boolean;
  readonly metaPresent: boolean;
  readonly logicalBatchId: string;
  readonly meta?: {
    readonly subjectIds: readonly AssetSubjectId[];
    readonly provenance: AssetProvenance;
  };
}

export interface SourceMetaRegistration {
  readonly sourcePath: string;
  readonly subjectIds: readonly AssetSubjectId[];
  readonly provenance: AssetProvenance;
}

export interface SourceMetaReconcileResult {
  readonly status: 'pending' | 'settled' | 'quarantined';
  readonly registration?: SourceMetaRegistration;
  readonly registrationCount: number;
  readonly delta: { readonly revisionChanged: boolean };
  readonly issues: readonly { readonly code: 'source-meta-pending' | 'orphan-meta' | 'source-only'; readonly message: string }[];
}

export interface SourceMetaReconciler {
  observe(observation: SourceMetaObservation): SourceMetaReconcileResult;
  stats(): { readonly registrations: number; readonly implicitDeletes: number; readonly sourceWrites: number };
}

interface SourceMetaState {
  sourcePresent: boolean;
  metaPresent: boolean;
  batchId: string;
  subjectIds: readonly AssetSubjectId[];
  provenance?: AssetProvenance;
  registered: boolean;
}

export function createSourceMetaReconciler(): SourceMetaReconciler {
  const states = new Map<string, SourceMetaState>();
  let registrations = 0;

  function observe(observation: SourceMetaObservation): SourceMetaReconcileResult {
    const prior = states.get(observation.sourcePath);
    const state: SourceMetaState = {
      sourcePresent: Boolean(prior?.sourcePresent || observation.sourcePresent),
      metaPresent: Boolean(prior?.metaPresent || observation.metaPresent),
      batchId: observation.logicalBatchId,
      subjectIds: observation.meta?.subjectIds ?? prior?.subjectIds ?? [],
      provenance: observation.meta?.provenance ?? prior?.provenance,
      registered: prior?.registered ?? false,
    };
    const provenance = state.provenance;
    const complete = state.sourcePresent && state.metaPresent && provenance !== undefined;
    if (complete && !state.registered) {
      state.registered = true;
      registrations += 1;
    }
    states.set(observation.sourcePath, state);
    if (complete) {
      return {
        status: 'settled',
        registrationCount: state.registered && !prior?.registered ? 1 : 0,
        registration: {
          sourcePath: observation.sourcePath,
          subjectIds: state.subjectIds,
          provenance: provenance as AssetProvenance,
        },
        delta: { revisionChanged: state.registered && !prior?.registered },
        issues: [],
      };
    }
    const code = state.metaPresent ? 'orphan-meta' : 'source-only';
    return {
      status: 'pending',
      registrationCount: 0,
      delta: { revisionChanged: false },
      issues: [{ code, message: code === 'orphan-meta' ? 'Metadata is retained until its source arrives.' : 'Source is observed without a metadata sidecar.' }],
    };
  }

  return {
    observe,
    stats: () => ({ registrations, implicitDeletes: 0, sourceWrites: 0 }),
  };
}
