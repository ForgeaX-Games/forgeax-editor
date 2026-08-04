import type {
  AssetMutationOperation,
  AssetSourceMutationIntent,
  AssetSubject,
  AssetSubjectId,
} from '../contracts/asset-workspace';

export interface SubjectOperationReason {
  readonly code: 'unsupported-subject-operation';
  readonly hint: string;
}

export interface SubjectOperationAvailability {
  readonly available: boolean;
  readonly reason?: SubjectOperationReason;
}

export interface AssetSubjectCapability {
  readonly subjectRef: AssetSubjectId;
  readonly operations: Readonly<Record<AssetMutationOperation | AssetSourceMutationIntent | 'preflight', SubjectOperationAvailability>>;
}

function unsupported(operation: string, subject: AssetSubject): SubjectOperationAvailability {
  return {
    available: false,
    reason: {
      code: 'unsupported-subject-operation',
      hint: `${operation} is not supported for ${subject.kind} subject ${subject.id}.`,
    },
  };
}

function available(value: boolean, operation: string, subject: AssetSubject): SubjectOperationAvailability {
  return value ? { available: true } : unsupported(operation, subject);
}

export function getAssetSubjectCapability(subject: AssetSubject): AssetSubjectCapability {
  const destructive = subject.capabilities.canPreflight;
  const movable = subject.capabilities.canMove;
  const deletable = subject.capabilities.canDelete;
  const sourceAuthoring = destructive && subject.kind === 'imported-output';
  const operations = {
    rename: available(destructive && movable, 'rename', subject),
    move: available(destructive && movable, 'move', subject),
    delete: available(destructive && deletable, 'delete', subject),
    replace: available(destructive && subject.kind !== 'imported-output', 'replace', subject),
    duplicate: available(destructive && subject.kind !== 'imported-output', 'duplicate', subject),
    reimport: available(destructive && subject.kind !== 'imported-output', 'reimport', subject),
    restore: available(destructive && deletable, 'restore', subject),
    'save-asset-source-override': available(sourceAuthoring, 'save-asset-source-override', subject),
    'reimport-asset': available(sourceAuthoring, 'reimport-asset', subject),
    'discard-source-overrides-and-reimport': available(sourceAuthoring, 'discard-source-overrides-and-reimport', subject),
    preflight: available(destructive, 'preflight', subject),
  } satisfies Readonly<Record<AssetMutationOperation | AssetSourceMutationIntent | 'preflight', SubjectOperationAvailability>>;
  return Object.freeze({ subjectRef: subject.id, operations });
}

export interface ImportedOutputRecord {
  readonly subjectId: AssetSubjectId;
  readonly producerIdentity?: string;
  readonly kind: string;
  readonly sourceIndex: number;
}

export interface ImportedOutputReference {
  readonly referenceId: string;
  readonly subjectId: AssetSubjectId;
}

export interface ReimportTopologyInput {
  readonly previous: readonly ImportedOutputRecord[];
  readonly next: readonly ImportedOutputRecord[];
  readonly references: readonly ImportedOutputReference[];
}

export interface ReimportTopologyMatch {
  readonly previousSubjectId: AssetSubjectId;
  readonly nextSubjectId: AssetSubjectId;
  readonly producerIdentity: string;
}

export interface ReimportTopologyAmbiguity {
  readonly previousSubjectId: AssetSubjectId;
  readonly candidateSubjectIds: readonly AssetSubjectId[];
}

export interface ReimportTopologyResult {
  readonly status: 'migrated' | 'ambiguous';
  readonly matches: readonly ReimportTopologyMatch[];
  readonly addedSubjectIds: readonly AssetSubjectId[];
  readonly removedSubjectIds: readonly AssetSubjectId[];
  readonly ambiguous: readonly ReimportTopologyAmbiguity[];
  readonly preservedReferences: readonly ImportedOutputReference[];
}

export function reconcileImportedTopology(input: ReimportTopologyInput): ReimportTopologyResult {
  const nextByIdentity = new Map<string, ImportedOutputRecord[]>();
  for (const output of input.next) {
    if (output.producerIdentity === undefined) continue;
    const entries = nextByIdentity.get(output.producerIdentity) ?? [];
    entries.push(output);
    nextByIdentity.set(output.producerIdentity, entries);
  }

  const matches: ReimportTopologyMatch[] = [];
  const ambiguous: ReimportTopologyAmbiguity[] = [];
  const matchedNext = new Set<AssetSubjectId>();
  const matchedPrevious = new Set<AssetSubjectId>();
  for (const previous of input.previous) {
    if (previous.producerIdentity === undefined) {
      const candidates = input.next
        .filter((next) => next.producerIdentity === undefined && next.sourceIndex === previous.sourceIndex)
        .map((next) => next.subjectId)
        .sort();
      if (candidates.length > 0) ambiguous.push({ previousSubjectId: previous.subjectId, candidateSubjectIds: candidates });
      continue;
    }
    const candidates = nextByIdentity.get(previous.producerIdentity) ?? [];
    if (candidates.length !== 1) {
      if (candidates.length > 1) {
        ambiguous.push({
          previousSubjectId: previous.subjectId,
          candidateSubjectIds: candidates.map((entry) => entry.subjectId).sort(),
        });
      }
      continue;
    }
    const next = candidates[0];
    if (!next) continue;
    matches.push({
      previousSubjectId: previous.subjectId,
      nextSubjectId: next.subjectId,
      producerIdentity: previous.producerIdentity,
    });
    matchedNext.add(next.subjectId);
    matchedPrevious.add(previous.subjectId);
  }

  const ambiguousPrevious = new Set(ambiguous.map((entry) => entry.previousSubjectId));
  const ambiguousNext = new Set(ambiguous.flatMap((entry) => entry.candidateSubjectIds));
  const addedSubjectIds = input.next
    .filter((entry) => !matchedNext.has(entry.subjectId) && !ambiguousNext.has(entry.subjectId))
    .map((entry) => entry.subjectId)
    .sort();
  const removedSubjectIds = input.previous
    .filter((entry) => !matchedPrevious.has(entry.subjectId) && !ambiguousPrevious.has(entry.subjectId))
    .map((entry) => entry.subjectId)
    .sort();
  const remap = new Map(matches.map((entry) => [entry.previousSubjectId, entry.nextSubjectId]));
  const preservedReferences = input.references
    .map((reference) => ({ ...reference, subjectId: remap.get(reference.subjectId) ?? reference.subjectId }))
    .sort((left, right) => left.referenceId.localeCompare(right.referenceId));
  return {
    status: ambiguous.length > 0 ? 'ambiguous' : 'migrated',
    matches: matches.sort((left, right) => left.previousSubjectId.localeCompare(right.previousSubjectId)),
    addedSubjectIds,
    removedSubjectIds,
    ambiguous: ambiguous.sort((left, right) => left.previousSubjectId.localeCompare(right.previousSubjectId)),
    preservedReferences,
  };
}
