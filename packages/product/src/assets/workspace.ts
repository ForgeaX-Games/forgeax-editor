import {
  createAssetWorkspaceSnapshot,
  createAssetSubject,
  snapshotFacts,
  type AssetRelation,
  type AssetSubject,
  type AssetSubjectId,
  type AssetSubjectInput,
  type AssetWorkspaceIssue,
  type AssetWorkspaceSnapshot,
} from '../contracts/asset-workspace';
import {
  createSourceMetaReconciler,
  type SourceMetaObservation,
} from './reconcile';

export interface AssetWorkspaceInput {
  readonly resourceRevision: string;
  readonly logicalCommitId?: string;
  readonly subjects: readonly AssetSubjectInput[];
  readonly relations: readonly AssetRelation[];
  readonly issues: readonly AssetWorkspaceIssue[];
}

export type AssetWorkspaceObservation =
  | ({ readonly kind: 'source-meta' } & SourceMetaObservation)
  | { readonly kind: 'guid-collision'; readonly guid: string; readonly subjectIds: readonly AssetSubjectId[]; readonly paths: readonly string[] }
  | { readonly kind: 'malformed-package'; readonly packageId: string; readonly path: string; readonly reason: string }
  | { readonly kind: 'revision-gap'; readonly rootId: string; readonly scope: string; readonly baselineRevision: string; readonly currentRevision: string }
  | { readonly kind: 'asset-change'; readonly rootId: string; readonly scope: string; readonly resourceRevision: string }
  | { readonly kind: 'vcs-burst'; readonly rootId: string; readonly scope: string }
  | { readonly kind: 'late-root'; readonly rootId: string; readonly scope: string }
  | { readonly kind: 'event-gap'; readonly rootId: string; readonly scope: string }
  | { readonly kind: 'dirty-conflict'; readonly subjectId: AssetSubjectId; readonly expectedRevision: string; readonly actualRevision: string };

export interface AssetWorkspaceRecoveryIntent {
  readonly kind: 'await-source' | 'await-meta' | 'resolve-collision' | 'quarantine-package' | 'scoped-reconcile';
  readonly scope?: string;
  readonly rootId?: string;
  readonly lastKnownGoodRevision?: string;
  readonly packageId?: string;
}

export interface AssetWorkspaceDelta {
  readonly revisionChanged: boolean;
  readonly fullScan: boolean;
  readonly addedSubjectIds: readonly AssetSubjectId[];
  readonly updatedSubjectIds: readonly AssetSubjectId[];
  readonly removedSubjectIds: readonly AssetSubjectId[];
}

export interface AssetWorkspaceResult {
  readonly status: 'observed' | 'pending' | 'quarantined' | 'settled';
  readonly snapshot: AssetWorkspaceSnapshot;
  readonly delta: AssetWorkspaceDelta;
  readonly issues: readonly AssetWorkspaceIssue[];
  readonly recoveryIntents: readonly AssetWorkspaceRecoveryIntent[];
  readonly mutationCount: 0;
  readonly collisionWinner?: never;
}

export interface AssetWorkspace extends AssetWorkspaceSnapshot {
  readonly snapshot: () => AssetWorkspaceSnapshot;
  readonly reconcile: (input: AssetWorkspaceInput) => AssetWorkspaceReconcileResult;
  readonly observe: (observation: AssetWorkspaceObservation) => AssetWorkspaceResult;
}

export interface AssetWorkspaceReconcileResult {
  readonly snapshot: AssetWorkspaceSnapshot;
  readonly delta: AssetWorkspaceDelta;
}

function emptySnapshot(): AssetWorkspaceSnapshot {
  return createAssetWorkspaceSnapshot({
    revision: 'workspace:r0',
    resourceRevision: 'resource:r0',
    subjects: [],
    relations: [],
    issues: [],
  });
}

function issue(
  code: AssetWorkspaceIssue['code'],
  message: string,
  subjectId?: AssetSubjectId,
): AssetWorkspaceIssue {
  return {
    code,
    severity: code === 'source-meta-pending' ? 'info' : 'warning',
    ...(subjectId ? { subjectId } : {}),
    message,
  };
}

function diffSubjects(before: AssetWorkspaceSnapshot, after: AssetWorkspaceSnapshot): AssetWorkspaceDelta {
  const prior = new Map(before.subjects.map((subject) => [subject.id, subject]));
  const next = new Map(after.subjects.map((subject) => [subject.id, subject]));
  const added: AssetSubjectId[] = [];
  const updated: AssetSubjectId[] = [];
  const removed: AssetSubjectId[] = [];
  for (const [id, subject] of next) {
    if (!prior.has(id)) added.push(id);
    else if (prior.get(id)?.stableIdentity !== subject.stableIdentity) updated.push(id);
  }
  for (const id of prior.keys()) if (!next.has(id)) removed.push(id);
  return {
    revisionChanged: before.revision !== after.revision,
    fullScan: false,
    addedSubjectIds: added,
    updatedSubjectIds: updated,
    removedSubjectIds: removed,
  };
}

export function createAssetWorkspace(): AssetWorkspace {
  let current = emptySnapshot();
  let revisionNumber = 0;
  let lastLogicalCommitId: string | undefined;
  const sourceMeta = createSourceMetaReconciler();

  const reconcile = (input: AssetWorkspaceInput): AssetWorkspaceReconcileResult => {
    const normalizedSubjects = input.subjects.map(createAssetSubject);
    const candidate = createAssetWorkspaceSnapshot({
      revision: current.revision,
      resourceRevision: input.resourceRevision,
      subjects: normalizedSubjects,
      relations: input.relations,
      issues: input.issues,
    });
    const changed = snapshotFacts(current) !== snapshotFacts(candidate)
      || current.resourceRevision !== input.resourceRevision;
    const duplicateCommit = input.logicalCommitId !== undefined && input.logicalCommitId === lastLogicalCommitId;
    if (changed && !duplicateCommit) {
      revisionNumber += 1;
      current = createAssetWorkspaceSnapshot({
        revision: `workspace:r${revisionNumber}`,
        resourceRevision: input.resourceRevision,
        subjects: normalizedSubjects,
        relations: input.relations,
        issues: input.issues,
      });
      lastLogicalCommitId = input.logicalCommitId;
    }
    return { snapshot: current, delta: diffSubjects(candidate, current) };
  };

  const observe = (observation: AssetWorkspaceObservation): AssetWorkspaceResult => {
    if (observation.kind === 'source-meta') {
      const settled = sourceMeta.observe(observation);
      const issues = settled.issues.map((entry) => issue(entry.code, entry.message));
      return {
        status: settled.status,
        snapshot: current,
        delta: { revisionChanged: settled.delta.revisionChanged, fullScan: false, addedSubjectIds: [], updatedSubjectIds: [], removedSubjectIds: [] },
        issues,
        recoveryIntents: settled.status === 'pending' ? [{ kind: observation.metaPresent ? 'await-source' : 'await-meta', scope: observation.sourcePath } as AssetWorkspaceRecoveryIntent] : [],
        mutationCount: 0,
      };
    }
    if (observation.kind === 'guid-collision') {
      return {
        status: 'quarantined', snapshot: current, delta: { revisionChanged: false, fullScan: false, addedSubjectIds: [], updatedSubjectIds: [], removedSubjectIds: [] },
        issues: [issue('guid-collision', `GUID ${observation.guid} is present in multiple subjects.`)],
        recoveryIntents: [{ kind: 'resolve-collision', scope: observation.paths.join(',') }], mutationCount: 0,
      };
    }
    if (observation.kind === 'malformed-package') {
      const malformedIssue = issue('malformed-package', observation.reason);
      current = createAssetWorkspaceSnapshot({ ...current, issues: [...current.issues, malformedIssue] });
      return {
        status: 'quarantined', snapshot: current, delta: { revisionChanged: false, fullScan: false, addedSubjectIds: [], updatedSubjectIds: [], removedSubjectIds: [] },
        issues: [malformedIssue], recoveryIntents: [{ kind: 'quarantine-package', packageId: observation.packageId, scope: observation.path }], mutationCount: 0,
      };
    }
    if (observation.kind === 'dirty-conflict') {
      const conflict = issue('dirty-conflict', `Expected ${observation.expectedRevision} but observed ${observation.actualRevision}.`, observation.subjectId);
      return {
        status: 'observed', snapshot: current, delta: { revisionChanged: false, fullScan: false, addedSubjectIds: [], updatedSubjectIds: [], removedSubjectIds: [] },
        issues: [conflict], recoveryIntents: [], mutationCount: 0,
      };
    }
    if (observation.kind === 'revision-gap' || observation.kind === 'vcs-burst' || observation.kind === 'late-root' || observation.kind === 'event-gap') {
      const lastKnownGoodRevision = observation.kind === 'revision-gap' ? observation.baselineRevision : current.resourceRevision;
      return {
        status: 'observed', snapshot: current, delta: { revisionChanged: false, fullScan: false, addedSubjectIds: [], updatedSubjectIds: [], removedSubjectIds: [] },
        issues: [], recoveryIntents: [{ kind: 'scoped-reconcile', rootId: observation.rootId, scope: observation.scope, lastKnownGoodRevision }], mutationCount: 0,
      };
    }
    return {
      status: 'observed', snapshot: current, delta: { revisionChanged: false, fullScan: false, addedSubjectIds: [], updatedSubjectIds: [], removedSubjectIds: [] },
      issues: [], recoveryIntents: [], mutationCount: 0,
    };
  };

  const workspace = {
    snapshot: () => current,
    reconcile,
    observe,
  } as AssetWorkspace;
  return workspace;
}

export function compareAssetWorkspaceSnapshots(
  snapshots: readonly AssetWorkspaceSnapshot[],
): { readonly equal: boolean; readonly differences: readonly string[] } {
  const first = snapshots[0];
  if (!first) return { equal: true, differences: [] };
  const differences: string[] = [];
  for (const [index, snapshot] of snapshots.slice(1).entries()) {
    if (snapshot.revision !== first.revision) differences.push(`consumer-${index + 1}:revision`);
    if (snapshot.identity !== first.identity) differences.push(`consumer-${index + 1}:identity`);
    if (JSON.stringify(snapshot.subjects) !== JSON.stringify(first.subjects)) differences.push(`consumer-${index + 1}:subjects`);
    if (JSON.stringify(snapshot.relations) !== JSON.stringify(first.relations)) differences.push(`consumer-${index + 1}:relations`);
    if (JSON.stringify(snapshot.issues) !== JSON.stringify(first.issues)) differences.push(`consumer-${index + 1}:issues`);
  }
  return { equal: differences.length === 0, differences };
}
