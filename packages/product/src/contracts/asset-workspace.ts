export const ASSET_WORKSPACE_SCHEMA_VERSION = 'asset-workspace/v1' as const;

export type AssetSubjectId = string;

export type AssetSubjectKind =
  | 'internal-asset'
  | 'external-package'
  | 'imported-output'
  | 'source-dependency'
  | 'derived-artifact'
  | 'reference';

export type AssetProvenanceOwner = 'engine' | 'platform-io' | 'editor' | 'external';

export interface AssetProvenance {
  readonly owner: AssetProvenanceOwner;
  readonly source: string;
  readonly packageId?: string;
}

export interface AssetSubjectCapabilities {
  readonly canImport: boolean;
  readonly canMove: boolean;
  readonly canDelete: boolean;
  readonly canPreflight: boolean;
}

export type AssetMutationOperation =
  | 'rename'
  | 'move'
  | 'delete'
  | 'replace'
  | 'duplicate'
  | 'reimport'
  | 'restore';

export interface AssetMutationRequest {
  readonly operation: AssetMutationOperation;
  readonly subjectId: AssetSubjectId;
  readonly expectedRevision?: string;
  readonly confirmationToken?: string;
  readonly scope?: string;
  readonly owner?: string;
  readonly idempotencyKey?: string;
  readonly payload?: unknown;
}

export interface AssetSubjectInput {
  readonly id: AssetSubjectId;
  readonly kind: AssetSubjectKind;
  readonly provenance: AssetProvenance;
  readonly resourceId: string;
  readonly path: string;
  readonly capabilities: AssetSubjectCapabilities;
  readonly name?: string;
}

export interface AssetSubject extends AssetSubjectInput {
  readonly stableIdentity: string;
}

export type AssetRelationKind = 'depends-on' | 'referenced-by' | 'contains' | 'derived-from';

export interface AssetRelation {
  readonly kind: AssetRelationKind;
  readonly from: AssetSubjectId;
  readonly to: AssetSubjectId;
}

export type AssetWorkspaceIssueSeverity = 'info' | 'warning' | 'error';

export type AssetWorkspaceIssueCode =
  | 'source-meta-pending'
  | 'orphan-meta'
  | 'source-only'
  | 'guid-collision'
  | 'malformed-package'
  | 'dirty-conflict';

export interface AssetWorkspaceIssue {
  readonly code: AssetWorkspaceIssueCode;
  readonly severity: AssetWorkspaceIssueSeverity;
  readonly subjectId?: AssetSubjectId;
  readonly message: string;
}

export interface AssetWorkspaceSnapshot {
  readonly schemaVersion: typeof ASSET_WORKSPACE_SCHEMA_VERSION;
  readonly revision: string;
  readonly resourceRevision: string;
  readonly identity: string;
  readonly subjects: readonly AssetSubject[];
  readonly relations: readonly AssetRelation[];
  readonly issues: readonly AssetWorkspaceIssue[];
}

export interface CreateAssetWorkspaceSnapshotInput {
  readonly revision: string;
  readonly resourceRevision: string;
  readonly subjects: readonly AssetSubjectInput[];
  readonly relations: readonly AssetRelation[];
  readonly issues: readonly AssetWorkspaceIssue[];
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== 'path' && key !== 'name')
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function digest(value: unknown): string {
  let hash = 2166136261;
  for (const character of JSON.stringify(stableValue(value))) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `workspace-snapshot:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function createAssetSubject(input: AssetSubjectInput): AssetSubject {
  const subject: AssetSubject = {
    ...input,
    stableIdentity: digest({
      id: input.id,
      kind: input.kind,
      provenance: input.provenance,
      resourceId: input.resourceId,
      capabilities: input.capabilities,
    }),
  };
  return Object.freeze(subject);
}

export function createAssetWorkspaceSnapshot(
  input: CreateAssetWorkspaceSnapshotInput,
): AssetWorkspaceSnapshot {
  const subjects = [...input.subjects].map(createAssetSubject);
  const relations = [...input.relations].sort((left, right) =>
    `${left.from}:${left.kind}:${left.to}`.localeCompare(`${right.from}:${right.kind}:${right.to}`));
  const issues = [...input.issues].sort((left, right) =>
    `${left.code}:${left.subjectId ?? ''}:${left.message}`.localeCompare(`${right.code}:${right.subjectId ?? ''}:${right.message}`));
  const identitySubjects = [...subjects].sort((left, right) => left.id.localeCompare(right.id));
  const snapshot: AssetWorkspaceSnapshot = {
    schemaVersion: ASSET_WORKSPACE_SCHEMA_VERSION,
    revision: input.revision,
    resourceRevision: input.resourceRevision,
    identity: digest({ subjects: identitySubjects, relations }),
    subjects: Object.freeze(subjects),
    relations: Object.freeze(relations),
    issues: Object.freeze(issues),
  };
  return Object.freeze(snapshot);
}

export function snapshotFacts(snapshot: AssetWorkspaceSnapshot): string {
  return JSON.stringify(stableValue({
    subjects: snapshot.subjects,
    relations: snapshot.relations,
  }));
}
