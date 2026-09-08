// Game-scoped, schema-versioned, append-only OperationRun journal.

import type { CommandError } from '../contracts/error';
import {
  acceptedEvent,
  createOperationRun,
  reduceOperationRun,
  type OperationRun,
  type OperationRunEvent,
  type OperationRunRequest,
  type OperationRunEventInput,
  type RunProgress,
} from '../contracts/run';
import { RunIndex } from './run-index';
import {
  reconcileOperationRuns,
  type ReconciliationResolution,
} from './run-reconciliation';

export type RunJournalRecord = OperationRunEvent;
export type RunJournalEventInput = OperationRunEventInput;

/**
 * Append-only provenance facts for a reference-creation run.
 *
 * These records intentionally do not describe scene entities or pack payloads.
 * They index the product orchestration and the Gateway OperationRun identities
 * so a later owner can resume the original run without replaying a committed
 * mutation. The native scene remains owned by Editor core and the engine.
 */
export const CREATION_RUN_RECORD_SCHEMA_VERSION = 'creation-run/v1' as const;

export interface CreationRunJournalRecord {
  readonly schemaVersion: typeof CREATION_RUN_RECORD_SCHEMA_VERSION;
  readonly sequence: number;
  readonly at: number;
  readonly creationRunId: string;
  readonly kind: string;
  readonly [key: string]: unknown;
}

export interface CreationRunJournalRecordInput {
  readonly creationRunId: string;
  readonly kind: string;
  readonly at?: number;
  readonly [key: string]: unknown;
}

export type CreationVisualReviewExpectation = 'edit-prop-after-reopen' | 'play-prop-roundtrip';
export type CreationVisualReviewVerdict = 'pass' | 'fail' | 'unproven';

export interface CreationCaptureProvenance {
  readonly backend: string;
  readonly rendererIdentity: string;
  readonly rendererGeneration: number;
  readonly carrierGeneration: number;
  readonly carrierId: string;
  readonly carrierKind: string;
  readonly runtimeId: string;
  readonly runtimeGeneration: number;
}

export interface CreationVisualReviewFacts {
  readonly authoredBy: 'verify';
  readonly executor: 'step-verify-visual-executor';
  readonly expectation: CreationVisualReviewExpectation;
  readonly observed: Readonly<Record<string, unknown>>;
  readonly verdict: CreationVisualReviewVerdict;
  readonly confidence: number;
  readonly mismatchReason?: string;
  readonly capture: {
    readonly runId: string;
    readonly tapePath: string;
    readonly reportPath: string;
  };
  readonly renderer: {
    readonly backend: string;
    readonly generation: number;
    readonly carrierGeneration: number;
    readonly rendererIdentity: string;
    readonly carrierId?: string;
    readonly carrierKind?: string;
    readonly runtimeId?: string;
    readonly runtimeGeneration?: number;
  };
}

export interface CreationRunJournalOptions {
  readonly now?: () => number;
  readonly onAppend?: (records: readonly CreationRunJournalRecord[]) => void;
}

export const CREATION_RUN_KINDS = [
  'run-created',
  'input-blocked',
  'native-seed-committed',
  'q5-gap-blocked',
  'q5-mutation-committed',
  'native-entity-committed',
  'correction',
  'correction-failed',
  'uncompleted-item',
  'evidence-failed',
  'stage-advanced',
  'save-committed',
  'capture-committed',
  'visual-review-committed',
  'final-report',
] as const;

export interface CreationRunJournalValidationError {
  readonly code: 'creation-journal-corrupt';
  readonly hint: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type CreationRunJournalValidationResult =
  | { readonly ok: true; readonly records: readonly CreationRunJournalRecord[] }
  | { readonly ok: false; readonly error: CreationRunJournalValidationError };

const creationRunKindSet = new Set<string>(CREATION_RUN_KINDS);

function validationError(hint: string, details?: Readonly<Record<string, unknown>>): CreationRunJournalValidationResult {
  return { ok: false, error: { code: 'creation-journal-corrupt', hint, ...(details === undefined ? {} : { details }) } };
}

function recordString(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return typeof value === 'string' && value.length > 0;
}

function recordStringArray(record: Record<string, unknown>, key: string, required = false): boolean {
  const value = record[key];
  return Array.isArray(value) && (!required || value.length > 0) && value.every((item) => typeof item === 'string' && item.trim().length > 0);
}

function recordNumber(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === 'number' && Number.isSafeInteger(record[key]) && (record[key] as number) >= 0;
}

function recordBoolean(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === 'boolean';
}

function recordIssueGroup(record: Record<string, unknown>): boolean {
  return recordString(record, 'issueGroupId') && recordStringArray(record, 'issues', true);
}

function recordCorrectionQueryFacts(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const facts = value as Record<string, unknown>;
  const entityIds = facts.entityIds;
  return facts.query === 'world.snapshot'
    && Array.isArray(facts.with)
    && facts.with.length === 1
    && facts.with[0] === 'Name'
    && recordNumber(facts, 'rowCount')
    && Array.isArray(entityIds)
    && entityIds.every((entity) => Number.isSafeInteger(entity) && (entity as number) >= 0)
    && recordStringArray(facts, 'names');
}

function recordCorrectionStageJudgment(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const judgment = value as Record<string, unknown>;
  return judgment.status === 'improved'
    || judgment.status === 'unchanged'
    || judgment.status === 'changed'
    || judgment.status === 'degraded'
    ? recordString(judgment, 'reason')
      && recordNumber(judgment, 'preRowCount')
      && recordNumber(judgment, 'postRowCount')
    : false;
}

function recordProvenance(record: Record<string, unknown>): boolean {
  const provenance = record.provenance;
  if (provenance === null || typeof provenance !== 'object' || Array.isArray(provenance)) return false;
  const facts = provenance as Record<string, unknown>;
  return Array.isArray(facts.sourceSequences)
    && facts.sourceSequences.length > 0
    && facts.sourceSequences.every((sequence) => Number.isSafeInteger(sequence) && (sequence as number) > 0)
    && Array.isArray(facts.operationRunIds)
    && facts.operationRunIds.length > 0
    && facts.operationRunIds.every((runId) => typeof runId === 'string' && runId.trim().length > 0);
}

export function isCreationCaptureProvenance(value: unknown): value is CreationCaptureProvenance {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const facts = value as Record<string, unknown>;
  return ['backend', 'rendererIdentity', 'carrierId', 'carrierKind', 'runtimeId']
    .every((key) => typeof facts[key] === 'string' && (facts[key] as string).trim() !== '')
    && ['rendererGeneration', 'carrierGeneration', 'runtimeGeneration']
      .every((key) => Number.isSafeInteger(facts[key]) && (facts[key] as number) > 0);
}

function sameCaptureProvenance(left: CreationCaptureProvenance, right: Record<string, unknown>): boolean {
  return left.backend === right.backend
    && left.rendererIdentity === right.rendererIdentity
    && left.rendererGeneration === right.generation
    && left.carrierGeneration === right.carrierGeneration
    && left.carrierId === right.carrierId
    && left.carrierKind === right.carrierKind
    && left.runtimeId === right.runtimeId
    && left.runtimeGeneration === right.runtimeGeneration;
}

export function validateCreationVisualReviewFacts(
  value: unknown,
  expected?: CreationVisualReviewExpectation,
): value is CreationVisualReviewFacts {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const facts = value as Record<string, unknown>;
  const observed = facts.observed;
  const capture = facts.capture;
  const renderer = facts.renderer;
  if (facts.authoredBy !== 'verify' || facts.executor !== 'step-verify-visual-executor'
    || (facts.expectation !== 'edit-prop-after-reopen' && facts.expectation !== 'play-prop-roundtrip')
    || (expected !== undefined && facts.expectation !== expected)
    || (facts.verdict !== 'pass' && facts.verdict !== 'fail' && facts.verdict !== 'unproven')
    || typeof facts.confidence !== 'number' || !Number.isFinite(facts.confidence) || facts.confidence < 0 || facts.confidence > 1
    || observed === null || typeof observed !== 'object' || Array.isArray(observed)) return false;
  if (facts.mismatchReason !== undefined && (typeof facts.mismatchReason !== 'string' || facts.mismatchReason.trim() === '')) return false;
  if (capture === null || typeof capture !== 'object' || Array.isArray(capture)
    || !isCreationRunCaptureArtifact(capture)) return false;
  if (renderer === null || typeof renderer !== 'object' || Array.isArray(renderer)) return false;
  const rendererFacts = renderer as Record<string, unknown>;
  const baseValid = typeof rendererFacts.backend === 'string' && rendererFacts.backend.trim() !== ''
    && Number.isSafeInteger(rendererFacts.generation) && (rendererFacts.generation as number) > 0
    && Number.isSafeInteger(rendererFacts.carrierGeneration) && (rendererFacts.carrierGeneration as number) > 0
    && typeof rendererFacts.rendererIdentity === 'string' && rendererFacts.rendererIdentity.trim() !== '';
  if (!baseValid) return false;
  return (rendererFacts.carrierId === undefined || typeof rendererFacts.carrierId === 'string')
    && (rendererFacts.carrierKind === undefined || typeof rendererFacts.carrierKind === 'string')
    && (rendererFacts.runtimeId === undefined || typeof rendererFacts.runtimeId === 'string')
    && (rendererFacts.runtimeGeneration === undefined || (Number.isSafeInteger(rendererFacts.runtimeGeneration) && (rendererFacts.runtimeGeneration as number) > 0));
}

function recordVisualReviewProvenance(record: Record<string, unknown>): boolean {
  const provenance = record.provenance;
  if (provenance === null || typeof provenance !== 'object' || Array.isArray(provenance)) return false;
  const facts = provenance as Record<string, unknown>;
  return facts.authoredBy === 'verify'
    && facts.executor === 'step-verify-visual-executor'
    && recordProvenance(record);
}

function validCreationPayload(record: Record<string, unknown>): boolean {
  switch (record.kind) {
    case 'run-created': {
      const budget = record.correctionBudget;
      return recordString(record, 'referenceFingerprint')
        && recordString(record, 'targetProject')
        && recordString(record, 'targetScene')
        && recordString(record, 'originalStage')
        && recordString(record, 'viewSemantics')
        && recordStringArray(record, 'visibleFacts', true)
        && recordStringArray(record, 'inferredFacts', true)
        && recordStringArray(record, 'unknownFacts', true)
        && recordStringArray(record, 'fidelityFocus', true)
        && budget !== null
        && typeof budget === 'object'
        && Number.isInteger((budget as Record<string, unknown>).perStage)
        && ((budget as Record<string, unknown>).perStage as number) >= 1
        && ((budget as Record<string, unknown>).perStage as number) <= 3
        && Number.isInteger((budget as Record<string, unknown>).total)
        && ((budget as Record<string, unknown>).total as number) >= 1
        && ((budget as Record<string, unknown>).total as number) <= 12;
    }
    case 'input-blocked':
      return recordString(record, 'code') && recordString(record, 'stage');
    case 'native-seed-committed':
      return recordString(record, 'mutationId') && recordString(record, 'operationRunId')
        && recordNumber(record, 'dispatchCount') && recordNumber(record, 'commitCount')
        && recordNumber(record, 'mutationCount') && recordString(record, 'originalStage')
        && (record.terminalStatus === undefined || record.terminalStatus === 'succeeded');
    case 'q5-gap-blocked':
      return record.capabilityId === 'scene.createAsset'
        && recordString(record, 'originalStage') && recordString(record, 'capabilityGeneration')
        && recordString(record, 'priorOperationRunId') && recordString(record, 'owner')
        && recordString(record, 'diagnosticId') && recordString(record, 'nextStep')
        && recordString(record, 'code') && recordString(record, 'expected');
    case 'q5-mutation-committed':
      return recordString(record, 'mutationId') && recordString(record, 'operationRunId')
        && recordString(record, 'capabilityGeneration') && recordNumber(record, 'mutationCount')
        && recordString(record, 'originalStage') && record.terminalStatus === 'succeeded';
    case 'native-entity-committed':
      return recordString(record, 'mutationId') && recordString(record, 'operationRunId')
        && recordString(record, 'name') && recordNumber(record, 'entity') && recordNumber(record, 'mutationCount')
        && recordNumber(record, 'dispatchCount') && recordNumber(record, 'commitCount')
        && recordString(record, 'stage') && record.terminalStatus === 'succeeded';
    case 'correction':
      return recordString(record, 'stage') && recordIssueGroup(record) && recordString(record, 'operationRunId')
        && record.budgetConsumed === true
        && recordCorrectionQueryFacts(record.preQuery)
        && recordCorrectionQueryFacts(record.postQuery)
        && recordCorrectionStageJudgment(record.stageJudgment);
    case 'correction-failed':
      return recordString(record, 'stage') && recordIssueGroup(record) && recordString(record, 'code')
        && recordBoolean(record, 'budgetConsumed')
        && (record.operationRunId === undefined || recordString(record, 'operationRunId'))
        && (record.preQuery === undefined || recordCorrectionQueryFacts(record.preQuery))
        && (record.postQuery === undefined || recordCorrectionQueryFacts(record.postQuery))
        && (record.stageJudgment === undefined || recordCorrectionStageJudgment(record.stageJudgment));
    case 'uncompleted-item':
      return recordString(record, 'item') && recordString(record, 'reason') && recordString(record, 'stage')
        && recordIssueGroup(record) && record.budgetConsumed === false;
    case 'evidence-failed':
      return recordString(record, 'evidenceKind') && recordString(record, 'requestId') && recordString(record, 'code');
    case 'stage-advanced':
      return recordString(record, 'stage') && recordString(record, 'evidenceId') && recordProvenance(record);
    case 'save-committed':
      return recordString(record, 'requestId') && recordString(record, 'operationRunId')
        && record.terminalStatus === 'succeeded' && recordProvenance(record);
    case 'capture-committed':
      return (record.stage === 'edit-after-reopen' || record.stage === 'play-roundtrip')
        && recordString(record, 'evidenceId') && recordString(record, 'requestId')
        && recordString(record, 'operationRunId') && record.terminalStatus === 'succeeded'
        && recordProvenance(record) && recordCaptureArtifact(record)
        && (record.captureProvenance === undefined || isCreationCaptureProvenance(record.captureProvenance));
    case 'visual-review-committed':
      return validateCreationVisualReviewFacts(record)
        && recordVisualReviewProvenance(record);
    case 'final-report':
      return ['input', 'structure', 'persistence', 'play', 'visual', 'toolCompleteness']
        .every((key) => record[key] === 'pass' || record[key] === 'fail' || record[key] === 'unproven')
        && (record.verdict === 'pass' || record.verdict === 'fail' || record.verdict === 'unproven')
        && recordStringArray(record, 'uncompletedItems');
    default:
      return false;
  }
}

export function isCreationRunCaptureArtifact(
  value: unknown,
): value is { readonly runId: string; readonly tapePath: string; readonly reportPath: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const artifact = value as Record<string, unknown>;
  if (!recordString(artifact, 'runId') || !recordString(artifact, 'tapePath') || !recordString(artifact, 'reportPath')) return false;
  const tapePath = artifact.tapePath as string;
  const reportPath = artifact.reportPath as string;
  const runId = artifact.runId as string;
  const tapeSuffix = /(?:^|[\\/])frame-0\.tape\.bin$/;
  const reportSuffix = /(?:^|[\\/])frame-0\.report\.json$/;
  if (!tapeSuffix.test(tapePath) || !reportSuffix.test(reportPath)) return false;
  if (reportPath !== tapePath.replace(/frame-0\.tape\.bin$/, 'frame-0.report.json')) return false;
  const tapeSegments = tapePath.split(/[\\/]/);
  return tapeSegments.length >= 2 && tapeSegments.at(-2) === runId;
}

function recordCaptureArtifact(record: Record<string, unknown>): boolean {
  return isCreationRunCaptureArtifact(record.artifact);
}

function captureProvenance(record: Record<string, unknown>): CreationCaptureProvenance | undefined {
  return isCreationCaptureProvenance(record.captureProvenance) ? record.captureProvenance : undefined;
}

function validateCreationRunSemantics(records: readonly CreationRunJournalRecord[]): CreationRunJournalValidationResult {
  const byRun = new Map<string, CreationRunJournalRecord[]>();
  const bySequence = new Map<number, CreationRunJournalRecord>();
  for (const record of records) {
    const run = byRun.get(record.creationRunId) ?? [];
    run.push(record);
    byRun.set(record.creationRunId, run);
    bySequence.set(record.sequence, record);
  }
  for (const [creationRunId, run] of byRun) {
    if (run[0]?.kind !== 'run-created' || run.filter((record) => record.kind === 'run-created').length !== 1) {
      return validationError('persisted creation journal must begin each run with exactly one run-created record.', { creationRunId });
    }
    const created = run[0];
    const originalStage = created.originalStage;
    const seed = run.find((record) => record.kind === 'native-seed-committed');
    const gap = run.find((record) => record.kind === 'q5-gap-blocked');
    const mutation = run.find((record) => record.kind === 'q5-mutation-committed');
    if (gap !== undefined && (seed === undefined || gap.priorOperationRunId !== seed.operationRunId)) {
      return validationError('persisted creation journal has a q5 gap that does not match the native seed terminal.', { creationRunId });
    }
    if (mutation !== undefined && (gap === undefined || mutation.originalStage !== gap.originalStage
      || mutation.capabilityGeneration === gap.capabilityGeneration)) {
      return validationError('persisted creation journal has a q5 mutation inconsistent with its blocked gap.', { creationRunId });
    }
    const stages = run.filter((record) => record.kind === 'stage-advanced');
    if (stages.length > 1) {
      return validationError('persisted creation journal has an invalid or duplicate stage advance.', { creationRunId });
    }
    const saves = run.filter((record) => record.kind === 'save-committed');
    if (saves.length > 1 || (saves.length === 1 && stages.length === 0)) {
      return validationError('persisted creation journal has a save outside the validated stage boundary.', { creationRunId });
    }
    const captures = run.filter((record) => record.kind === 'capture-committed');
    if (captures.some((record) => saves.length === 0 || stages.length === 0)) {
      return validationError('persisted creation journal has capture evidence before a validated save and stage.', { creationRunId });
    }
    if (captures.filter((record) => record.stage === 'edit-after-reopen').length > 1
      || captures.filter((record) => record.stage === 'play-roundtrip').length > 1) {
      return validationError('persisted creation journal contains duplicate capture evidence.', { creationRunId });
    }
    for (const capture of captures) {
      const artifact = capture.artifact as Record<string, unknown>;
      if (artifact.runId === capture.operationRunId) {
        return validationError('persisted capture evidence must keep artifactRunId distinct from operationRunId.', { creationRunId, sequence: capture.sequence });
      }
      const producer = captureProvenance(capture);
      if (capture.captureProvenance !== undefined && producer === undefined) {
        return validationError('persisted capture evidence contains invalid producer provenance.', { creationRunId, sequence: capture.sequence });
      }
    }
    const visualReviews = run.filter((record) => record.kind === 'visual-review-committed');
    if (visualReviews.some((record) => !validateCreationVisualReviewFacts(record))) {
      return validationError('persisted creation journal contains invalid Verify visual review facts.', { creationRunId });
    }
    if (visualReviews.some((record) => visualReviews.filter((other) => other.expectation === record.expectation).length > 1)) {
      return validationError('persisted creation journal contains duplicate visual review expectations.', { creationRunId });
    }
    for (const review of visualReviews) {
      const captureStage = review.expectation === 'edit-prop-after-reopen' ? 'edit-after-reopen' : 'play-roundtrip';
      const capture = captures.find((record) => record.stage === captureStage);
      const provenance = review.provenance as Record<string, unknown>;
      const sourceSequences = provenance.sourceSequences;
      const operationRunIds = provenance.operationRunIds;
      if (capture === undefined
        || (review.capture as Record<string, unknown>).runId !== (capture.artifact as Record<string, unknown>).runId
        || !Array.isArray(sourceSequences) || !sourceSequences.includes(capture.sequence)
        || !Array.isArray(operationRunIds) || !operationRunIds.includes(capture.operationRunId)) {
        return validationError('persisted visual review facts do not match the corresponding capture provenance.', { creationRunId, expectation: review.expectation });
      }
      const producer = captureProvenance(capture);
      if (producer !== undefined && !sameCaptureProvenance(producer, review.renderer as Record<string, unknown>)) {
        return validationError('persisted visual review renderer facts do not match the producer capture provenance.', { creationRunId, expectation: review.expectation });
      }
    }
    for (const evidence of run.filter((record) => ['stage-advanced', 'save-committed', 'capture-committed'].includes(record.kind))) {
      const provenance = evidence.provenance as Record<string, unknown> | undefined;
      const sourceSequences = provenance?.sourceSequences;
      const provenanceOperationRunIds = provenance?.operationRunIds;
      const operationRunIds = new Set(run
        .filter((record) => record.sequence <= evidence.sequence)
        .map((record) => record.operationRunId)
        .filter((runId): runId is string => typeof runId === 'string'));
      if (!Array.isArray(sourceSequences) || sourceSequences.some((sequence) => (
        !Number.isSafeInteger(sequence) || (sequence as number) >= evidence.sequence
          || bySequence.get(sequence as number)?.creationRunId !== creationRunId
      )) || !Array.isArray(provenanceOperationRunIds) || provenanceOperationRunIds.some((runId) => (
        typeof runId !== 'string' || !operationRunIds.has(runId)
      ))) {
        return validationError('persisted creation journal contains provenance facts that do not match prior records.', { creationRunId, sequence: evidence.sequence });
      }
    }
    const reports = run.filter((record) => record.kind === 'final-report');
    if (reports.length > 1 || (reports.length === 1 && captures.length < 2)) {
      return validationError('persisted creation journal has a final report before both capture facts.', { creationRunId });
    }
    if (reports.some((report) => report.visual !== 'unproven' && visualReviews.length === 0)) {
      return validationError('persisted final report cannot claim a visual verdict without Verify-authored visual review facts.', { creationRunId });
    }
  }
  return { ok: true, records };
}

export function validateCreationRunJournalRecords(records: readonly unknown[]): CreationRunJournalValidationResult {
  if (!Array.isArray(records)) return validationError('persisted creation journal must be an array of append-only records.');
  const normalized: CreationRunJournalRecord[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const raw = records[index];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return validationError('persisted creation journal contains a non-record value.', { index });
    }
    const candidate = raw as Record<string, unknown>;
    if (candidate.schemaVersion !== CREATION_RUN_RECORD_SCHEMA_VERSION
      || !Number.isSafeInteger(candidate.sequence) || candidate.sequence !== index + 1
      || typeof candidate.at !== 'number' || !Number.isFinite(candidate.at)
      || !recordString(candidate, 'creationRunId') || !recordString(candidate, 'kind')) {
      return validationError('persisted creation journal failed sequence or envelope validation.', { index });
    }
    if (!creationRunKindSet.has(candidate.kind as string)) {
      return validationError('persisted creation journal contains an unknown record kind.', { index, kind: candidate.kind });
    }
    if (!validCreationPayload(candidate)) {
      return validationError('persisted creation journal record is missing required payload.', { index, kind: candidate.kind });
    }
    normalized.push(Object.freeze({ ...candidate }) as CreationRunJournalRecord);
  }
  return validateCreationRunSemantics(normalized);
}

/** Small append-only journal for product-owned creation provenance. */
export class CreationRunJournal {
  private readonly now: () => number;
  private readonly onAppend?: (records: readonly CreationRunJournalRecord[]) => void;
  private readonly records: CreationRunJournalRecord[] = [];
  private corruption?: CreationRunJournalValidationError;

  constructor(options: CreationRunJournalOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.onAppend = options.onAppend;
  }

  static fromRecords(records: readonly unknown[], options: CreationRunJournalOptions = {}): CreationRunJournal {
    const journal = new CreationRunJournal(options);
    const validated = validateCreationRunJournalRecords(records);
    if (!validated.ok) {
      journal.corruption = validated.error;
      return journal;
    }
    journal.records.push(...validated.records);
    return journal;
  }

  validationError(): CreationRunJournalValidationError | undefined {
    return this.corruption;
  }

  append(input: CreationRunJournalRecordInput): CreationRunJournalRecord {
    if (this.corruption !== undefined) {
      throw new Error(this.corruption.hint);
    }
    const sequence = (this.records.at(-1)?.sequence ?? 0) + 1;
    const record = Object.freeze({
      ...input,
      schemaVersion: CREATION_RUN_RECORD_SCHEMA_VERSION,
      sequence,
      at: input.at ?? this.now(),
    }) as CreationRunJournalRecord;
    const tentative = Object.freeze([...this.records, record]);
    const validated = validateCreationRunJournalRecords(tentative);
    if (!validated.ok) {
      this.corruption = validated.error;
      throw new Error(validated.error.hint);
    }
    this.onAppend?.(tentative);
    this.records.push(record);
    return record;
  }

  listRecords(creationRunId?: string): readonly CreationRunJournalRecord[] {
    const selected = creationRunId === undefined
      ? this.records
      : this.records.filter((record) => record.creationRunId === creationRunId);
    return Object.freeze(selected.map((record) => Object.freeze({ ...record })));
  }
}

export interface RunJournalOptions {
  readonly scope: string;
  readonly now?: () => number;
  readonly retention?: {
    /** Legacy accepted-order retention used by generic callers. */
    readonly maxRuns?: number;
    /** Save-adopter retention: only completed runs count toward the bound. */
    readonly maxTerminalRuns?: number;
  };
}

export interface RunJournalFromRecordsOptions extends RunJournalOptions {
  readonly records: readonly unknown[];
}

export type RunJournalAcceptResult =
  | { readonly ok: true; readonly runId: string; readonly reused: boolean; readonly run: OperationRun }
  | { readonly ok: false; readonly error: CommandError };

export type RunJournalResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: CommandError };

function failure(code: string, hint: string, recoveryActions: readonly string[] = []): { readonly ok: false; readonly error: CommandError } {
  return { ok: false, error: { code, hint, retryable: false, recoveryActions } };
}

function stable(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
}

function isRunEvent(value: unknown): value is OperationRunEvent {
  if (value === null || typeof value !== 'object') return false;
  const event = value as Partial<OperationRunEvent>;
  return typeof event.type === 'string' && typeof event.runId === 'string' && typeof event.sequence === 'number' && typeof event.at === 'number';
}

function eventKey(event: OperationRunEvent): string {
  return `${event.runId}:${event.sequence}`;
}

export class RunJournal {
  private readonly scope: string;
  private readonly now: () => number;
  private readonly maxRuns: number | undefined;
  private readonly maxTerminalRuns: number | undefined;
  private readonly records: RunJournalRecord[] = [];
  private readonly index = new RunIndex();
  private readonly idempotency = new Map<string, { readonly operationId: string; readonly input: string; readonly runId: string }>();
  private readonly requestIds = new Map<string, { readonly operationId: string; readonly input: string; readonly runId: string }>();
  private readonly terminalRunIds: string[] = [];
  private readonly expiredRuns = new Set<string>();
  private isolatedRecordCount = 0;

  constructor(options: RunJournalOptions) {
    this.scope = options.scope;
    this.now = options.now ?? (() => Date.now());
    this.maxRuns = options.retention?.maxRuns;
    this.maxTerminalRuns = options.retention?.maxTerminalRuns;
  }

  static fromRecords(options: RunJournalFromRecordsOptions): RunJournal {
    const journal = new RunJournal(options);
    for (const raw of options.records) journal.restore(raw);
    journal.prune();
    return journal;
  }

  accept(request: OperationRunRequest): RunJournalAcceptResult {
    if (request.scope !== this.scope) return failure('scope-mismatch', 'A run must be accepted in the journal scope.') as RunJournalAcceptResult;
    if (request.requestId !== undefined) {
      const existingRequest = this.requestIds.get(request.requestId);
      if (existingRequest !== undefined) {
        if (existingRequest.operationId !== request.operationId || existingRequest.input !== stable(request.input)) {
          return failure('operation-request-id-conflict', 'requestId was already used for a different operation intent.') as RunJournalAcceptResult;
        }
        const existing = this.index.get(existingRequest.runId);
        if (existing !== undefined) return { ok: true, runId: existing.runId, reused: true, run: existing };
        if (this.expiredRuns.has(existingRequest.runId)) {
          return failure('run-expired', 'The requestId identifies a terminal run that has expired.', ['run.list']) as RunJournalAcceptResult;
        }
        return failure('run-not-found', 'The requestId identifies a run that is not available.', ['run.list']) as RunJournalAcceptResult;
      }
    }
    const key = request.idempotencyKey;
    if (key !== undefined) {
      const identity = this.idempotency.get(`${request.operationId}:${key}`);
      if (identity !== undefined) {
        if (identity.input !== stable(request.input)) return failure('idempotency-conflict', 'The idempotency key was reused with a different payload.') as RunJournalAcceptResult;
        const existing = this.index.get(identity.runId);
        if (existing !== undefined) return { ok: true, runId: existing.runId, reused: true, run: existing };
        if (this.expiredRuns.has(identity.runId)) return failure('run-expired', 'The idempotent run has expired from the derived index.', ['run.list']) as RunJournalAcceptResult;
      }
    }
    const created = createOperationRun(request, this.now());
    if (!created.ok) return created;
    const appended = this.appendRecord(acceptedEvent(created.value));
    if (!appended.ok) return appended as RunJournalAcceptResult;
    if (request.requestId !== undefined) {
      this.requestIds.set(request.requestId, {
        operationId: request.operationId,
        input: stable(request.input),
        runId: created.value.runId,
      });
    }
    if (key !== undefined) this.idempotency.set(`${request.operationId}:${key}`, { operationId: request.operationId, input: stable(request.input), runId: created.value.runId });
    this.prune();
    return { ok: true, runId: created.value.runId, reused: false, run: this.index.get(created.value.runId) ?? created.value };
  }

  append(input: RunJournalEventInput): RunJournalResult<OperationRun> {
    const run = this.index.get(input.runId);
    if (run === undefined) return failure('run-not-found', `run "${input.runId}" is not known.`, ['run.list']);
    const event = { ...input, sequence: input.sequence ?? run.sequence + 1 } as OperationRunEvent;
    if (event.type === 'accepted') return failure('invalid-run-transition', 'An accepted record can only be written once.');
    const result = reduceOperationRun(run, event);
    if (!result.ok) return result;
    const appended = this.appendRecord(event);
    if (!appended.ok) return appended;
    if (isTerminalEvent(event)) this.pruneTerminalRuns();
    return result;
  }

  getRun(runId: string): OperationRun | undefined {
    return this.index.get(runId);
  }

  getRunByRequestId(requestId: string): OperationRun | undefined {
    const identity = this.requestIds.get(requestId);
    return identity === undefined ? undefined : this.index.get(identity.runId);
  }

  getRunResult(runId: string): RunJournalResult<OperationRun> {
    if (this.index.has(runId)) return { ok: true, value: this.index.get(runId)! };
    const expired = this.expiredRuns.has(runId) || this.records.some((record) => record.runId === runId);
    return failure(expired ? 'run-expired' : 'run-not-found', `run "${runId}" is ${expired ? 'expired' : 'unknown'}.`, ['run.list']);
  }

  getRunResultByRequestId(requestId: string): RunJournalResult<OperationRun> {
    const identity = this.requestIds.get(requestId);
    if (identity === undefined) return failure('run-not-found', `requestId "${requestId}" is unknown.`, ['run.list']);
    return this.getRunResult(identity.runId);
  }

  listRuns(): readonly OperationRun[] {
    return this.index.values();
  }

  getEffectResult(effectKey: string): { readonly runId: string; readonly result: unknown } | undefined {
    for (const run of this.index.values()) {
      if (Object.prototype.hasOwnProperty.call(run.effectResults, effectKey)) return { runId: run.runId, result: run.effectResults[effectKey] };
    }
    return undefined;
  }

  listEvents(runId: string): readonly RunJournalRecord[] {
    return Object.freeze(this.records.filter((record) => record.runId === runId).map((record) => Object.freeze({ ...record })));
  }

  listRecords(): readonly RunJournalRecord[] {
    return Object.freeze(this.records.map((record) => Object.freeze({ ...record })));
  }

  updateProgress(runId: string, progress: RunProgress): RunJournalResult<OperationRun> {
    return this.append({ type: 'progress', runId, at: this.now(), progress });
  }

  reconcile(options: { readonly resolve: (context: { readonly run: OperationRun }) => ReconciliationResolution }): { readonly ok: true; readonly reconciled: readonly string[] } {
    const resolutions = reconcileOperationRuns(this.index.values(), options.resolve);
    const reconciled: string[] = [];
    for (const { run, resolution } of resolutions) {
      const event = resolutionEvent(run, resolution, this.now());
      const result = this.append(event);
      if (result.ok) reconciled.push(run.runId);
    }
    return { ok: true, reconciled: Object.freeze(reconciled) };
  }

  diagnostics(): { readonly isolatedRecords: number } {
    return { isolatedRecords: this.isolatedRecordCount };
  }

  private appendRecord(event: OperationRunEvent): RunJournalResult<OperationRun> {
    if (event.type === 'assert-terminal') return failure('invalid-run-event', 'assert-terminal is a query, not a journal record.');
    const current = this.index.get(event.runId);
    if (event.type !== 'accepted' && current === undefined) return failure('run-not-found', `run "${event.runId}" is not known.`, ['run.list']);
    const next = event.type === 'accepted' ? createOperationRun({
      runId: event.runId,
      ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
      operationId: event.operationId,
      actor: event.actor,
      sessionId: event.sessionId,
      scope: event.scope,
      ...(event.input === undefined ? {} : { input: event.input }),
      ...(event.parentRunId === undefined ? {} : { parentRunId: event.parentRunId }),
      traceId: event.traceId,
      ...(event.idempotencyKey === undefined ? {} : { idempotencyKey: event.idempotencyKey }),
      attempt: event.attempt,
      cancellable: event.cancellable,
      retryable: event.retryable,
    }, event.at) : reduceOperationRun(current!, event);
    if (!next.ok) return next;
    this.records.push(Object.freeze({ ...event }));
    this.index.set(next.value);
    if (event.type === 'accepted') {
      if (event.requestId !== undefined) {
        this.requestIds.set(event.requestId, {
          operationId: event.operationId,
          input: stable(event.input),
          runId: event.runId,
        });
      }
    } else if (isTerminalEvent(event) && !this.terminalRunIds.includes(event.runId)) {
      this.terminalRunIds.push(event.runId);
    }
    return next;
  }

  private restore(raw: unknown): void {
    if (!isRunEvent(raw) || raw.type === 'assert-terminal') {
      this.isolatedRecordCount++;
      return;
    }
    if (raw.type === 'accepted' && raw.scope !== this.scope) {
      this.isolatedRecordCount++;
      return;
    }
    const current = this.index.get(raw.runId);
    if (raw.type !== 'accepted' && current === undefined) {
      this.isolatedRecordCount++;
      return;
    }
    const result = this.appendRecord(raw);
    if (!result.ok) {
      this.isolatedRecordCount++;
      return;
    }
    if (raw.type === 'accepted' && raw.idempotencyKey !== undefined) {
      this.idempotency.set(`${raw.operationId}:${raw.idempotencyKey}`, { operationId: raw.operationId, input: stable(raw.input), runId: raw.runId });
    }
  }

  private prune(): void {
    if (this.maxRuns !== undefined && this.maxRuns >= 1) {
      const acceptedRuns = [...new Set(this.records.filter((record) => record.type === 'accepted').map((record) => record.runId))];
      while (acceptedRuns.length > this.maxRuns) {
        const oldest = acceptedRuns.shift();
        if (oldest === undefined) break;
        this.expiredRuns.add(oldest);
        this.index.delete(oldest);
      }
    }
    this.pruneTerminalRuns();
  }

  private pruneTerminalRuns(): void {
    if (this.maxTerminalRuns === undefined || this.maxTerminalRuns < 1) return;
    while (this.terminalRunIds.length > this.maxTerminalRuns) {
      const oldest = this.terminalRunIds.shift();
      if (oldest === undefined) break;
      this.expiredRuns.add(oldest);
      this.index.delete(oldest);
    }
  }
}

function isTerminalEvent(event: OperationRunEvent): boolean {
  return event.type === 'succeeded' || event.type === 'failed' || event.type === 'cancelled';
}

function resolutionEvent(run: OperationRun, resolution: ReconciliationResolution, at: number): RunJournalEventInput {
  if (resolution.state === 'succeeded') return { type: 'succeeded', runId: run.runId, at, result: resolution.result };
  if (resolution.state === 'failed') return {
    type: 'failed',
    runId: run.runId,
    at,
    error: resolution.error ?? {
      code: 'reconciliation-failed',
      hint: 'The restart reconciliation did not prove a successful effect.',
      retryable: true,
      recoveryActions: ['operation.retry'],
    },
  };
  return { type: 'cancelled', runId: run.runId, at, error: resolution.error };
}
