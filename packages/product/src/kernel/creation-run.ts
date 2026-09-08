// Product-owned creation-run state and reducer.
//
// The kernel stores provenance, uncertainty, budget, and recovery facts only.
// It never owns a World, an EntityHandle, a scene payload, or a pack writer.
// Those authored facts stay behind the Editor Gateway/applier boundary.

import {
  CreationRunJournal,
  type CreationRunJournalRecord,
  type CreationRunJournalRecordInput,
  isCreationCaptureProvenance,
  type CreationVisualReviewFacts,
  type CreationVisualReviewVerdict,
  validateCreationVisualReviewFacts,
} from './run-journal';

export const CREATION_RUN_SCHEMA_VERSION = 'reference-creation-run/v1' as const;
export const CREATION_STAGE_BLOCKOUT = 'blockout' as const;
export const CREATION_NEXT_STEP_NATIVE_SEED = 'native-seed' as const;
export const CREATION_NEXT_STEP_OWNER_REPAIR = 'owner.repair' as const;

export interface CreationBudget {
  readonly perStage: number;
  readonly total: number;
}

export interface CreationRunInput {
  readonly creationRunId: string;
  readonly referenceFingerprint: string;
  readonly targetProject: string;
  readonly targetScene: string;
  readonly originalStage: string;
  readonly viewSemantics: string;
  readonly visibleFacts: readonly string[];
  readonly inferredFacts: readonly string[];
  readonly unknownFacts: readonly string[];
  readonly fidelityFocus: readonly string[];
  readonly correctionBudget: CreationBudget;
}

export interface CreationQ5Gap {
  readonly capabilityId: 'scene.createAsset';
  readonly originalStage: string;
  readonly capabilityGeneration: string;
  readonly priorOperationRunId: string;
  readonly owner: string;
  readonly diagnosticId: string;
  readonly nextStep: typeof CREATION_NEXT_STEP_OWNER_REPAIR;
  readonly code: string;
  readonly expected: string;
}

export interface CreationQ5Mutation {
  readonly mutationId: string;
  readonly operationRunId: string;
  readonly capabilityGeneration: string;
}

export interface CreationNativeEntityRecord {
  readonly mutationId: string;
  readonly operationRunId: string;
  readonly entity: number;
  readonly name: string;
}

export interface CreationRunState {
  readonly schemaVersion: typeof CREATION_RUN_SCHEMA_VERSION;
  readonly creationRunId: string;
  readonly originalStage: string;
  readonly currentStage: string;
  readonly referenceFingerprint: string;
  readonly targetProject: string;
  readonly targetScene: string;
  readonly viewSemantics: string;
  readonly visibleFacts: readonly string[];
  readonly inferredFacts: readonly string[];
  readonly unknownFacts: readonly string[];
  readonly fidelityFocus: readonly string[];
  readonly correctionBudget: CreationBudget;
  readonly correctionCountByStage: Readonly<Record<string, number>>;
  readonly totalCorrectionCount: number;
  readonly dispatchCount: number;
  readonly commitCount: number;
  readonly mutationCount: number;
  readonly saveCount: number;
  readonly captureCount: number;
  readonly visualReviews?: readonly CreationVisualReviewFacts[];
  readonly stageAdvanceCount: number;
  readonly committedMutationIds: readonly string[];
  readonly priorOperationRunId?: string;
  readonly q5Gap?: CreationQ5Gap;
  readonly q5Mutation?: CreationQ5Mutation;
  readonly nativeEntities: readonly CreationNativeEntityRecord[];
  readonly status: 'running' | 'blocked';
  readonly nextStep: string;
  readonly records: readonly CreationRunJournalRecord[];
}

export interface CreationRunProvenanceFacts {
  readonly sourceSequences: readonly number[];
  readonly operationRunIds: readonly string[];
  readonly capabilityGeneration?: string;
}

export interface CreationRunVisualReviewError {
  readonly code: 'creation-run-not-found' | 'visual-review-invalid' | 'visual-review-order-invalid' | 'visual-review-duplicate';
  readonly stage: 'finalize';
  readonly hint: string;
  readonly retryable: false;
  readonly recoveryActions: readonly string[];
}

export type CreationRunVisualReviewResult =
  | { readonly ok: true; readonly value: CreationRunState }
  | { readonly ok: false; readonly error: CreationRunVisualReviewError; readonly value: CreationRunState };

export function creationRunVisualReviewStatus(state: CreationRunState): CreationVisualReviewVerdict {
  const reviews = state.visualReviews ?? [];
  if (reviews.length === 0 || reviews.some((review) => review.verdict === 'unproven')) return 'unproven';
  return reviews.some((review) => review.verdict === 'fail') ? 'fail' : 'pass';
}

export function creationRunProvenance(state: CreationRunState): CreationRunProvenanceFacts {
  const sourceKinds = new Set(['q5-mutation-committed', 'native-entity-committed', 'stage-advanced', 'save-committed']);
  const sourceSequences = state.records
    .filter((record) => sourceKinds.has(record.kind))
    .map((record) => record.sequence);
  const operationRunIds = state.records
    .map((record) => record.operationRunId)
    .filter((runId): runId is string => typeof runId === 'string' && runId.length > 0);
  return Object.freeze({
    sourceSequences: Object.freeze([...new Set(sourceSequences)]),
    operationRunIds: Object.freeze([...new Set(operationRunIds)]),
    ...(state.q5Mutation === undefined ? {} : { capabilityGeneration: state.q5Mutation.capabilityGeneration }),
  });
}

export interface CreationRunInputError {
  readonly code: 'creation-input-incomplete' | 'creation-input-invalid';
  readonly stage: 'preflight';
  readonly hint: string;
  readonly retryable: false;
  readonly recoveryActions: readonly string[];
}

export type CreationRunKernelResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: CreationRunInputError; readonly value: T };

function frozenStrings(values: readonly string[]): readonly string[] {
  return Object.freeze([...values]);
}

function inputError(code: CreationRunInputError['code'], hint: string): CreationRunInputError {
  return Object.freeze({
    code,
    stage: 'preflight' as const,
    hint,
    retryable: false as const,
    recoveryActions: Object.freeze(['creation.input.review']),
  });
}

function validBudget(budget: CreationBudget): boolean {
  return Number.isInteger(budget.perStage) && budget.perStage > 0 && budget.perStage <= 3 &&
    Number.isInteger(budget.total) && budget.total > 0 && budget.total <= 12;
}

function recordInput(input: CreationRunInput): CreationRunJournalRecordInput {
  return {
    creationRunId: input.creationRunId,
    kind: 'run-created',
    referenceFingerprint: input.referenceFingerprint,
    targetProject: input.targetProject,
    targetScene: input.targetScene,
    originalStage: input.originalStage,
    viewSemantics: input.viewSemantics,
    visibleFacts: frozenStrings(input.visibleFacts),
    inferredFacts: frozenStrings(input.inferredFacts),
    unknownFacts: frozenStrings(input.unknownFacts),
    fidelityFocus: frozenStrings(input.fidelityFocus),
    correctionBudget: Object.freeze({ ...input.correctionBudget }),
  };
}

function runCreated(records: readonly CreationRunJournalRecord[]): CreationRunJournalRecord | undefined {
  return records.find((record) => record.kind === 'run-created');
}

function numberField(record: CreationRunJournalRecord, key: string): number {
  const value = record[key];
  return typeof value === 'number' ? value : 0;
}

function stringField(record: CreationRunJournalRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

export class CreationRunKernel {
  readonly journal: CreationRunJournal;

  constructor(journal = new CreationRunJournal()) {
    this.journal = journal;
  }

  begin(input: CreationRunInput): CreationRunKernelResult<CreationRunState> {
    const existing = this.state(input.creationRunId);
    if (existing !== undefined) return { ok: true, value: existing };
    this.journal.append(recordInput(input));
    const state = this.state(input.creationRunId);
    if (state === undefined) throw new Error(`creation run did not initialize: ${input.creationRunId}`);

    if (input.referenceFingerprint.trim() === '' || input.targetProject.trim() === '' || input.targetScene.trim() === ''
      || input.viewSemantics.trim() === '' || input.visibleFacts.length === 0 || input.fidelityFocus.length === 0) {
      const error = inputError('creation-input-incomplete', 'reference fingerprint, view semantics, target project/scene, visible facts, fidelity focus, and budget are required before mutation.');
      this.journal.append({ creationRunId: input.creationRunId, kind: 'input-blocked', code: error.code, stage: error.stage });
      return { ok: false, error, value: this.state(input.creationRunId)! };
    }
    if (input.originalStage.trim() === '' || !validBudget(input.correctionBudget)
      || input.inferredFacts.some((fact) => fact.trim() === '')
      || input.unknownFacts.some((fact) => fact.trim() === '')
      || input.targetProject.includes('..') || input.targetScene.includes('..')) {
      const error = inputError('creation-input-invalid', 'original stage, uncertainty facts, target boundary, and bounded correction budget are required.');
      this.journal.append({ creationRunId: input.creationRunId, kind: 'input-blocked', code: error.code, stage: error.stage });
      return { ok: false, error, value: this.state(input.creationRunId)! };
    }
    return { ok: true, value: state };
  }

  append(record: CreationRunJournalRecordInput): CreationRunState {
    this.journal.append(record);
    const state = this.state(record.creationRunId);
    if (state === undefined) throw new Error(`unknown creation run: ${record.creationRunId}`);
    return state;
  }

  state(creationRunId: string): CreationRunState | undefined {
    const records = this.journal.listRecords(creationRunId);
    const first = runCreated(records);
    if (first === undefined) return undefined;
    const originalStage = stringField(first, 'originalStage') ?? CREATION_STAGE_BLOCKOUT;
    const correctionCounts: Record<string, number> = {};
    const committedMutationIds: string[] = [];
    let dispatchCount = 0;
    let commitCount = 0;
    let mutationCount = 0;
    let saveCount = 0;
    let captureCount = 0;
    const visualReviews: CreationVisualReviewFacts[] = [];
    let stageAdvanceCount = 0;
    let priorOperationRunId: string | undefined;
    let q5Gap: CreationQ5Gap | undefined;
    let q5Mutation: CreationQ5Mutation | undefined;
    const nativeEntities: CreationNativeEntityRecord[] = [];
    let currentStage = originalStage;
    let status: CreationRunState['status'] = 'running';
    let nextStep: string = CREATION_NEXT_STEP_NATIVE_SEED;

    for (const record of records) {
      if (record.kind === 'native-seed-committed') {
        dispatchCount += numberField(record, 'dispatchCount');
        commitCount += numberField(record, 'commitCount');
        mutationCount += numberField(record, 'mutationCount');
        const mutationId = stringField(record, 'mutationId');
        if (mutationId !== undefined && !committedMutationIds.includes(mutationId)) committedMutationIds.push(mutationId);
        priorOperationRunId = stringField(record, 'operationRunId') ?? priorOperationRunId;
        nextStep = 'scene.createAsset';
      } else if (record.kind === 'correction'
        || (record.kind === 'correction-failed' && record.budgetConsumed === true)) {
        const stage = stringField(record, 'stage') ?? currentStage;
        correctionCounts[stage] = (correctionCounts[stage] ?? 0) + 1;
      } else if (record.kind === 'save-committed') {
        saveCount += 1;
      } else if (record.kind === 'capture-committed') {
        captureCount += 1;
      } else if (record.kind === 'visual-review-committed' && validateCreationVisualReviewFacts(record)) {
        visualReviews.push(record);
      } else if (record.kind === 'stage-advanced') {
        stageAdvanceCount += 1;
        currentStage = stringField(record, 'stage') ?? currentStage;
      } else if (record.kind === 'q5-gap-blocked') {
        const candidate: CreationQ5Gap = {
          capabilityId: 'scene.createAsset',
          originalStage: stringField(record, 'originalStage') ?? originalStage,
          capabilityGeneration: stringField(record, 'capabilityGeneration') ?? 'g0',
          priorOperationRunId: stringField(record, 'priorOperationRunId') ?? priorOperationRunId ?? '',
          owner: stringField(record, 'owner') ?? 'unknown-owner',
          diagnosticId: stringField(record, 'diagnosticId') ?? 'unknown-diagnostic',
          nextStep: CREATION_NEXT_STEP_OWNER_REPAIR,
          code: stringField(record, 'code') ?? 'capability-gap',
          expected: stringField(record, 'expected') ?? 'request-correlated terminal OperationRun',
        };
        q5Gap = Object.freeze(candidate);
        currentStage = candidate.originalStage;
        status = 'blocked';
        nextStep = CREATION_NEXT_STEP_OWNER_REPAIR;
      } else if (record.kind === 'q5-mutation-committed') {
        mutationCount += numberField(record, 'mutationCount');
        const mutationId = stringField(record, 'mutationId');
        const operationRunId = stringField(record, 'operationRunId');
        const capabilityGeneration = stringField(record, 'capabilityGeneration');
        if (mutationId !== undefined && operationRunId !== undefined && capabilityGeneration !== undefined) {
          q5Mutation = Object.freeze({ mutationId, operationRunId, capabilityGeneration });
          if (!committedMutationIds.includes(mutationId)) committedMutationIds.push(mutationId);
        }
        status = 'running';
        nextStep = 'save';
      } else if (record.kind === 'native-entity-committed') {
        const mutationId = stringField(record, 'mutationId');
        const operationRunId = stringField(record, 'operationRunId');
        const name = stringField(record, 'name');
        const entityValue: unknown = record.entity;
        const entity = typeof entityValue === 'number' && Number.isSafeInteger(entityValue) && entityValue >= 0
          ? entityValue
          : undefined;
        if (mutationId !== undefined && operationRunId !== undefined && name !== undefined
          && entity !== undefined
          && !nativeEntities.some((item) => item.mutationId === mutationId)) {
          nativeEntities.push(Object.freeze({
            mutationId,
            operationRunId,
            name,
            entity,
          }));
          mutationCount += numberField(record, 'mutationCount');
          if (!committedMutationIds.includes(mutationId)) committedMutationIds.push(mutationId);
          nextStep = 'save';
        }
      }
    }

    const budget = first.correctionBudget as CreationBudget;
    return Object.freeze({
      schemaVersion: CREATION_RUN_SCHEMA_VERSION,
      creationRunId,
      originalStage,
      currentStage,
      referenceFingerprint: String(first.referenceFingerprint ?? ''),
      targetProject: String(first.targetProject ?? ''),
      targetScene: String(first.targetScene ?? ''),
      viewSemantics: String(first.viewSemantics ?? ''),
      visibleFacts: frozenStrings((first.visibleFacts as readonly string[] | undefined) ?? []),
      inferredFacts: frozenStrings((first.inferredFacts as readonly string[] | undefined) ?? []),
      unknownFacts: frozenStrings((first.unknownFacts as readonly string[] | undefined) ?? []),
      fidelityFocus: frozenStrings((first.fidelityFocus as readonly string[] | undefined) ?? []),
      correctionBudget: Object.freeze({ ...budget }),
      correctionCountByStage: Object.freeze({ ...correctionCounts }),
      totalCorrectionCount: Object.values(correctionCounts).reduce((sum, count) => sum + count, 0),
      dispatchCount,
      commitCount,
      mutationCount,
      saveCount,
      captureCount,
      visualReviews: Object.freeze(visualReviews),
      stageAdvanceCount,
      committedMutationIds: frozenStrings(committedMutationIds),
      ...(priorOperationRunId === undefined ? {} : { priorOperationRunId }),
      ...(q5Gap === undefined ? {} : { q5Gap }),
      ...(q5Mutation === undefined ? {} : { q5Mutation }),
      nativeEntities: Object.freeze(nativeEntities),
      status,
      nextStep,
      records,
    });
  }

  appendVisualReview(creationRunId: string, facts: CreationVisualReviewFacts): CreationRunVisualReviewResult {
    const state = this.state(creationRunId);
    if (state === undefined) return {
      ok: false,
      error: { code: 'creation-run-not-found', stage: 'finalize', hint: `creation run "${creationRunId}" is not known.`, retryable: false, recoveryActions: ['creation.run.list'] },
      value: this.emptyState(creationRunId),
    };
    if (!validateCreationVisualReviewFacts(facts)) return {
      ok: false,
      error: { code: 'visual-review-invalid', stage: 'finalize', hint: 'Verify visual review facts must include an expectation, external verdict, confidence, capture artifact, and renderer provenance.', retryable: false, recoveryActions: ['visual.review.retry'] },
      value: state,
    };
    if ((state.visualReviews ?? []).some((review) => review.expectation === facts.expectation)) return {
      ok: false,
      error: { code: 'visual-review-duplicate', stage: 'finalize', hint: `visual review for expectation "${facts.expectation}" is already recorded.`, retryable: false, recoveryActions: ['creation.run.resume'] },
      value: state,
    };
    const captureStage = facts.expectation === 'edit-prop-after-reopen' ? 'edit-after-reopen' : 'play-roundtrip';
    const capture = state.records.find((record) => record.kind === 'capture-committed' && record.stage === captureStage);
    if (capture === undefined || (capture.artifact as Record<string, unknown>).runId !== facts.capture.runId) return {
      ok: false,
      error: { code: 'visual-review-order-invalid', stage: 'finalize', hint: 'Verify visual review facts must reference the matching committed capture for their expectation.', retryable: false, recoveryActions: ['capture.retry'] },
      value: state,
    };
    const provenance = {
      sourceSequences: [capture.sequence],
      operationRunIds: [capture.operationRunId as string],
      authoredBy: facts.authoredBy,
      executor: facts.executor,
    };
    const captureProvenance = capture.captureProvenance;
    if (captureProvenance !== undefined) {
      if (!isCreationCaptureProvenance(captureProvenance)
        || facts.renderer.backend !== captureProvenance.backend
        || facts.renderer.rendererIdentity !== captureProvenance.rendererIdentity
        || facts.renderer.generation !== captureProvenance.rendererGeneration
        || facts.renderer.carrierGeneration !== captureProvenance.carrierGeneration
        || facts.renderer.carrierId !== captureProvenance.carrierId
        || facts.renderer.carrierKind !== captureProvenance.carrierKind
        || facts.renderer.runtimeId !== captureProvenance.runtimeId
        || facts.renderer.runtimeGeneration !== captureProvenance.runtimeGeneration) {
        return {
          ok: false,
          error: { code: 'visual-review-order-invalid', stage: 'finalize', hint: 'Verify visual review facts must reproduce the exact persisted producer capture provenance.', retryable: false, recoveryActions: ['capture.retry'] },
          value: state,
        };
      }
    }
    return { ok: true, value: this.append({ creationRunId, kind: 'visual-review-committed', ...facts, provenance }) };
  }

  private emptyState(creationRunId: string): CreationRunState {
    return {
      schemaVersion: CREATION_RUN_SCHEMA_VERSION,
      creationRunId,
      originalStage: '',
      currentStage: '',
      referenceFingerprint: '',
      targetProject: '',
      targetScene: '',
      viewSemantics: '',
      visibleFacts: [],
      inferredFacts: [],
      unknownFacts: [],
      fidelityFocus: [],
      correctionBudget: { perStage: 0, total: 0 },
      correctionCountByStage: {},
      totalCorrectionCount: 0,
      dispatchCount: 0,
      commitCount: 0,
      mutationCount: 0,
      saveCount: 0,
      captureCount: 0,
      visualReviews: [],
      stageAdvanceCount: 0,
      committedMutationIds: [],
      nativeEntities: [],
      status: 'blocked',
      nextStep: CREATION_NEXT_STEP_OWNER_REPAIR,
      records: [],
    };
  }
}
