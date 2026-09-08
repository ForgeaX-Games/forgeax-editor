// Minimal reference-creation runtime for the M2 red/blocked slice.
//
// Discovery and authored mutation stay Gateway-owned. This module only chooses
// a discovered terminal native seed, waits for its real run, and records the
// current createAsset completion gap. It does not write a World, scene, pack,
// or private asset format.

import {
  capabilityGapError,
  type CapabilityGapError,
} from '../contracts/capability';
import {
  REFERENCE_CREATION_REQUIRED_INPUTS,
  REFERENCE_CREATION_LIFECYCLE,
  REFERENCE_CREATION_SHORTEST_ROUTE,
  REFERENCE_CREATION_SKILL_MANIFEST,
  type ReferenceCreationLifecycleRoute,
} from '../contracts/manifest';
import {
  CreationRunKernel,
  CREATION_NEXT_STEP_OWNER_REPAIR,
  creationRunProvenance,
  creationRunVisualReviewStatus,
  type CreationRunInput,
  type CreationRunState,
} from '../kernel/creation-run';
import {
  CreationRunJournal,
  isCreationCaptureProvenance,
  isCreationRunCaptureArtifact,
  type CreationRunJournalRecord,
  type CreationCaptureProvenance,
  type CreationVisualReviewFacts,
  validateCreationVisualReviewFacts,
  validateCreationRunJournalRecords,
} from '../kernel/run-journal';

export interface GatewayOperationDescriptor {
  readonly id: string;
  readonly available?: boolean;
  readonly availability?: { readonly available?: boolean };
  readonly argsSchema?: unknown;
  readonly inputSchema?: unknown;
  readonly operationRun?: boolean | null | Record<string, unknown>;
  readonly completion?: unknown;
  readonly recoveryActions?: readonly string[];
  readonly capabilityGeneration?: string;
  readonly stage?: string;
  readonly owner?: string;
  readonly expected?: string;
  readonly source?: string;
  readonly recoveryAction?: string;
  readonly diagnosticId?: string;
  readonly blocked?: {
    readonly code?: string;
    readonly stage?: string;
    readonly owner?: string;
    readonly diagnosticId?: string;
    readonly recoveryAction?: string;
  };
}

export interface GatewayAssetEntry {
  readonly guid: string;
  readonly kind: string;
  readonly name?: string;
}

export interface GatewayCreationQueryInput {
  readonly with: readonly ['Name'];
}

export interface GatewayCreationQueryRow {
  readonly entity?: unknown;
  readonly Name?: { readonly value?: unknown };
  readonly [component: string]: unknown;
}

export interface GatewayCreationQuerySnapshot {
  readonly rows: readonly GatewayCreationQueryRow[];
}

export type GatewayCreationQueryResult =
  | GatewayCreationQuerySnapshot
  | { readonly ok: false; readonly error: GatewayCreationError };

export interface GatewayOperationRun {
  readonly requestId: string;
  readonly runId: string;
  readonly operationId?: string;
  readonly status: 'accepted' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  readonly result?: unknown;
}

interface GatewayCaptureArtifact {
  readonly runId: string;
  readonly tapePath: string;
  readonly reportPath: string;
  readonly provenance: CreationCaptureProvenance;
}

export interface GatewayCreationCommand {
  readonly kind: string;
  readonly [key: string]: unknown;
}

export type GatewayCreationDispatchResult =
  | { readonly ok: true; readonly operationRun?: GatewayOperationRun; readonly result?: { readonly operationRun?: GatewayOperationRun } }
  | { readonly ok: false; readonly error: GatewayCreationError };

export type GatewayCreationRunResult =
  | { readonly ok: true; readonly value: GatewayOperationRun & { readonly status: 'accepted' | 'running' | 'succeeded' | 'failed' | 'cancelled' }; }
  | { readonly ok: false; readonly error: GatewayCreationError };

export interface GatewayCreationError {
  readonly code: string;
  readonly hint?: string;
  readonly retryable?: boolean;
  readonly recoveryActions?: readonly string[];
  readonly stage?: string;
  readonly expected?: unknown;
  readonly source?: string;
  readonly owner?: string;
  readonly diagnosticId?: string;
  readonly recoveryAction?: string;
  readonly capabilityGeneration?: string;
  readonly [key: string]: unknown;
}

export interface ReferenceCreationIssueGroup {
  readonly id: string;
  readonly issues: readonly string[];
}

export interface ReferenceCreationCorrection {
  readonly stage: string;
  readonly issueGroup: ReferenceCreationIssueGroup;
  readonly command: GatewayCreationCommand;
}

export interface GatewayCreationPort {
  readonly listOps: () => readonly GatewayOperationDescriptor[];
  readonly assetCatalog: () => readonly GatewayAssetEntry[];
  readonly query?: (input: GatewayCreationQueryInput) => GatewayCreationQueryResult;
  readonly dispatch: (command: GatewayCreationCommand, origin: 'ai') => GatewayCreationDispatchResult;
  readonly getOperationRunResult?: (requestId: string) => GatewayCreationRunResult;
  readonly waitOperationRun: (requestId: string) => Promise<GatewayCreationRunResult>;
  readonly reconnect?: (previousCapabilityGeneration: string) => void;
}

export interface ReferenceCreationNativeEntitySpec {
  readonly mutationId: string;
  readonly name: string;
  readonly parent?: number;
  readonly components: Record<string, unknown>;
}

export type ReferenceCreationAction =
  | 'discover'
  | 'preflight'
  | 'start'
  | 'resume'
  | 'ownerRepairAndResume'
  | 'createNativeEntities'
  | 'correct'
  | 'recordEvidence'
  | 'appendVisualReview'
  | 'finalize'
  | 'journal';

export interface ReferenceCreationParameterShape {
  readonly type: 'object';
  readonly required: readonly string[];
  readonly properties: Readonly<Record<string, { readonly type: string; readonly required?: readonly string[] }>>;
}

export interface ReferenceCreationActionDescriptor {
  readonly stage: 'discover' | 'preflight' | 'lifecycle' | 'native-creation' | 'correction' | 'evidence' | 'visual-review' | 'finalize' | 'journal';
  readonly action: ReferenceCreationAction;
  readonly method: 'reference-creation';
  readonly entryMethod: 'skill' | keyof ReferenceCreationEntry;
  readonly parameters: ReferenceCreationParameterShape;
  readonly result: string;
  readonly terminalResult: ReferenceCreationTerminalResult;
  readonly terminal: true;
}

export interface ReferenceCreationTerminalResult {
  readonly success: 'ReferenceCreationResult.run';
  readonly failure: 'ReferenceCreationResult.error';
  readonly operationRunStatuses: readonly ['accepted', 'running', 'succeeded', 'failed', 'cancelled'];
  readonly terminalOperationRunStatuses: readonly ['succeeded', 'failed', 'cancelled'];
}

export interface ReferenceCreationSkillDescriptor {
  readonly id: 'forgeax-reference-creation';
  readonly name: string;
  readonly purpose: string;
  readonly requiredInputs: typeof REFERENCE_CREATION_REQUIRED_INPUTS;
  readonly boundaries: readonly string[];
  readonly shortestRoute: typeof REFERENCE_CREATION_SHORTEST_ROUTE;
  readonly actions: readonly ReferenceCreationActionDescriptor[];
  readonly terminalResult: ReferenceCreationTerminalResult;
  readonly lifecycle: ReferenceCreationLifecycleRoute;
  readonly publicEntry: 'createReferenceCreationEntry';
  readonly zeroWritePreflight: {
    readonly mutates: false;
    readonly checks: readonly string[];
  };
  readonly capabilities: readonly {
    readonly id: string;
    readonly available: boolean;
    readonly operationRun: boolean;
    readonly inputSchema: unknown;
    readonly completion: unknown;
    readonly recoveryActions: readonly string[];
    readonly capabilityGeneration?: string;
  }[];
}

export interface ReferenceCreationFinalReport {
  readonly creationRunId: string;
  readonly verdict: 'pass' | 'fail' | 'unproven';
  readonly input: 'pass' | 'fail' | 'unproven';
  readonly structure: 'pass' | 'fail' | 'unproven';
  readonly persistence: 'pass' | 'fail' | 'unproven';
  readonly play: 'pass' | 'fail' | 'unproven';
  readonly visual: 'pass' | 'fail' | 'unproven';
  readonly toolCompleteness: 'pass' | 'fail' | 'unproven';
  readonly uncompletedItems: readonly string[];
}

export interface ReferenceCreationRuntimeOptions {
  readonly gateway: GatewayCreationPort;
  readonly journal?: CreationRunJournal;
  readonly journalError?: ReferenceCreationFailure;
}

export interface ReferenceCreationJournalStore {
  readonly read: () => unknown;
  readonly write: (records: readonly CreationRunJournalRecord[]) => void;
}

export interface ReferenceCreationEntryOptions {
  readonly gateway: GatewayCreationPort;
  readonly journal?: CreationRunJournal;
  readonly journalStore?: ReferenceCreationJournalStore;
}

export interface ReferenceCreationEntry {
  readonly runtime: ReferenceCreationRuntime;
  readonly skill: () => ReferenceCreationSkillDescriptor;
  readonly journal: (creationRunId?: string) => readonly CreationRunJournalRecord[];
  readonly preflight: ReferenceCreationRuntime['preflight'];
  readonly start: ReferenceCreationRuntime['start'];
  readonly resume: ReferenceCreationRuntime['resume'];
  readonly ownerRepairAndResume: ReferenceCreationRuntime['ownerRepairAndResume'];
  readonly createNativeEntities: ReferenceCreationRuntime['createNativeEntities'];
  readonly correct: ReferenceCreationRuntime['correct'];
  readonly finalize: ReferenceCreationRuntime['finalize'];
  readonly recordEvidence: ReferenceCreationRuntime['recordEvidence'];
  readonly appendVisualReview: ReferenceCreationRuntime['appendVisualReview'];
}

export type ReferenceCreationPreflightResult = ReturnType<ReferenceCreationRuntime['preflight']>;

export interface ReferenceCreationFailure {
  readonly code: string;
  readonly stage: 'preflight' | 'dispatch' | 'wait' | 'correction' | 'finalize';
  readonly hint: string;
  readonly retryable: boolean;
  readonly recoveryActions: readonly string[];
  readonly expected?: unknown;
  readonly capabilityId?: string;
  readonly capabilityGeneration?: string;
  readonly source?: string;
  readonly owner?: string;
  readonly diagnosticId?: string;
  readonly recoveryAction?: string;
  readonly details?: unknown;
}

export type ReferenceCreationResult =
  | { readonly ok: true; readonly run: CreationRunState }
  | { readonly ok: false; readonly error: ReferenceCreationFailure | CapabilityGapError; readonly run: CreationRunState };

type ReferenceCreationFailureOptions = Pick<ReferenceCreationFailure, 'retryable' | 'expected' | 'source' | 'capabilityId' | 'capabilityGeneration' | 'owner' | 'diagnosticId' | 'recoveryAction'>;

function failure(
  code: string,
  stage: ReferenceCreationFailure['stage'],
  hint: string,
  recoveryActions: readonly string[] = [],
  options: Partial<ReferenceCreationFailureOptions> = {},
): ReferenceCreationFailure {
  return Object.freeze({
    code,
    stage,
    hint,
    retryable: options.retryable ?? false,
    recoveryActions: Object.freeze([...recoveryActions]),
    ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)),
  });
}

function gatewayFailure(
  error: GatewayCreationError,
  stage: ReferenceCreationFailure['stage'],
  fallbackRecoveryActions: readonly string[],
): ReferenceCreationFailure {
  return failure(error.code, stage, error.hint ?? error.code, error.recoveryActions ?? fallbackRecoveryActions, {
    retryable: error.retryable,
    expected: error.expected,
    source: error.source,
    capabilityGeneration: error.capabilityGeneration,
    owner: error.owner,
    diagnosticId: error.diagnosticId,
    recoveryAction: error.recoveryAction,
  });
}

function journalRecoveryFailure(hint: string, details?: unknown): ReferenceCreationFailure {
  return Object.freeze({
    ...failure('creation-journal-corrupt', 'preflight', hint, ['creation.journal.recover']),
    details,
  });
}

function decodePersistedJournal(value: unknown):
  | { readonly ok: true; readonly records: readonly unknown[] }
  | { readonly ok: false; readonly error: ReferenceCreationFailure } {
  if (!Array.isArray(value)) {
    return { ok: false, error: journalRecoveryFailure('persisted creation journal must be an array of append-only records.') };
  }
  const validated = validateCreationRunJournalRecords(value as readonly unknown[]);
  return validated.ok
    ? { ok: true, records: validated.records }
    : { ok: false, error: journalRecoveryFailure(validated.error.hint, validated.error.details) };
}

export function createReferenceCreationSkill(
  listOps: () => readonly GatewayOperationDescriptor[],
): ReferenceCreationSkillDescriptor {
  const capabilities = listOps()
    .filter((entry) => ['addSceneAssetToScene', 'createAsset', 'spawnEntity', 'saveDocToDisk'].includes(entry.id))
    .map((entry) => Object.freeze({
      id: entry.id,
      available: operationAvailable(entry),
      operationRun: hasOperationRun(entry),
      inputSchema: entry.inputSchema ?? entry.argsSchema ?? null,
      completion: entry.completion ?? null,
      recoveryActions: Object.freeze([...(entry.recoveryActions ?? [])]),
      ...(entry.stage === undefined ? {} : { stage: entry.stage }),
      ...(entry.owner === undefined ? {} : { owner: entry.owner }),
      ...(entry.expected === undefined ? {} : { expected: entry.expected }),
      ...(entry.recoveryAction === undefined ? {} : { recoveryAction: entry.recoveryAction }),
      ...(entry.diagnosticId === undefined ? {} : { diagnosticId: entry.diagnosticId }),
      ...(entry.capabilityGeneration === undefined ? {} : { capabilityGeneration: entry.capabilityGeneration }),
    }));
  return Object.freeze({
    ...REFERENCE_CREATION_SKILL_MANIFEST,
    shortestRoute: REFERENCE_CREATION_SHORTEST_ROUTE,
    actions: referenceCreationActionDescriptors(),
    terminalResult: REFERENCE_CREATION_TERMINAL_RESULT,
    lifecycle: REFERENCE_CREATION_LIFECYCLE,
    capabilities: Object.freeze(capabilities),
  });
}

const REFERENCE_CREATION_TERMINAL_RESULT: ReferenceCreationTerminalResult = Object.freeze({
  success: 'ReferenceCreationResult.run',
  failure: 'ReferenceCreationResult.error',
  operationRunStatuses: Object.freeze(['accepted', 'running', 'succeeded', 'failed', 'cancelled'] as const),
  terminalOperationRunStatuses: Object.freeze(['succeeded', 'failed', 'cancelled'] as const),
});

function actionDescriptor(
  stage: ReferenceCreationActionDescriptor['stage'],
  action: ReferenceCreationAction,
  entryMethod: ReferenceCreationActionDescriptor['entryMethod'],
  required: readonly string[],
  properties: ReferenceCreationParameterShape['properties'],
  result: string,
): ReferenceCreationActionDescriptor {
  return Object.freeze({
    stage,
    action,
    method: 'reference-creation',
    entryMethod,
    parameters: Object.freeze({ type: 'object', required: Object.freeze([...required]), properties: Object.freeze({ ...properties }) }),
    result,
    terminalResult: REFERENCE_CREATION_TERMINAL_RESULT,
    terminal: true,
  });
}

function referenceCreationActionDescriptors(): readonly ReferenceCreationActionDescriptor[] {
  const action = { type: 'string' } as const;
  const creationRunId = { type: 'string' } as const;
  const input = { type: 'object', required: REFERENCE_CREATION_REQUIRED_INPUTS } as const;
  return Object.freeze([
    actionDescriptor('discover', 'discover', 'skill', ['action'], { action }, 'ReferenceCreationSkillDescriptor'),
    actionDescriptor('preflight', 'preflight', 'preflight', ['action', 'input'], { action, input }, 'ReferenceCreationPreflightResult'),
    actionDescriptor('preflight', 'start', 'start', ['action', 'input'], { action, input }, 'ReferenceCreationResult'),
    actionDescriptor('lifecycle', 'resume', 'resume', ['action', 'creationRunId'], { action, creationRunId }, 'ReferenceCreationRunResult'),
    actionDescriptor('lifecycle', 'ownerRepairAndResume', 'ownerRepairAndResume', ['action', 'creationRunId'], { action, creationRunId }, 'ReferenceCreationResult'),
    actionDescriptor('native-creation', 'createNativeEntities', 'createNativeEntities', ['action', 'creationRunId', 'specs'], { action, creationRunId, specs: { type: 'array' } }, 'ReferenceCreationResult'),
    actionDescriptor('correction', 'correct', 'correct', ['action', 'creationRunId', 'correction'], { action, creationRunId, correction: { type: 'object' } }, 'ReferenceCreationResult'),
    actionDescriptor('evidence', 'recordEvidence', 'recordEvidence', ['action', 'creationRunId', 'event'], { action, creationRunId, event: { type: 'object' } }, 'ReferenceCreationResult'),
    actionDescriptor('visual-review', 'appendVisualReview', 'appendVisualReview', ['action', 'creationRunId', 'facts'], { action, creationRunId, facts: { type: 'object' } }, 'ReferenceCreationResult'),
    actionDescriptor('finalize', 'finalize', 'finalize', ['action', 'creationRunId', 'dimensions'], { action, creationRunId, dimensions: { type: 'object' } }, 'ReferenceCreationResult'),
    actionDescriptor('journal', 'journal', 'journal', ['action', 'creationRunId'], { action, creationRunId }, 'CreationRunJournalRecord[]'),
  ]);
}

function blockedDescriptor(port: GatewayCreationPort): GatewayOperationDescriptor | undefined {
  return port.listOps().find((entry) => entry.id === 'createAsset');
}

function operationAvailable(descriptor: GatewayOperationDescriptor | undefined): boolean {
  return descriptor?.available === true || descriptor?.availability?.available === true;
}

function hasOperationRun(descriptor: GatewayOperationDescriptor | undefined): boolean {
  const operationRun = descriptor?.operationRun;
  return operationRun === true || (operationRun !== null && operationRun !== undefined && typeof operationRun === 'object');
}

function acceptedOperationRun(result: GatewayCreationDispatchResult): GatewayOperationRun | undefined {
  if (!result.ok) return undefined;
  return result.operationRun ?? result.result?.operationRun;
}

interface CorrectionQueryFacts {
  readonly query: 'world.snapshot';
  readonly with: readonly ['Name'];
  readonly rowCount: number;
  readonly entityIds: readonly number[];
  readonly names: readonly string[];
}

interface CorrectionStageJudgment {
  readonly status: 'improved' | 'unchanged' | 'changed' | 'degraded';
  readonly reason: string;
  readonly preRowCount: number;
  readonly postRowCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCreationRunInputShape(value: unknown): value is CreationRunInput {
  if (!isRecord(value)) return false;
  const strings = REFERENCE_CREATION_REQUIRED_INPUTS.filter((key) => key !== 'visibleFacts' && key !== 'inferredFacts' && key !== 'unknownFacts' && key !== 'fidelityFocus' && key !== 'correctionBudget');
  if (strings.some((key) => typeof value[key] !== 'string')) return false;
  if (!['visibleFacts', 'inferredFacts', 'unknownFacts', 'fidelityFocus'].every((key) => Array.isArray(value[key]) && (value[key] as unknown[]).every((item) => typeof item === 'string'))) return false;
  const budget = value.correctionBudget;
  return isRecord(budget)
    && Number.isInteger(budget.perStage)
    && Number.isInteger(budget.total);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function safeCreationRunId(value: unknown): string {
  return isRecord(value) && nonEmptyString(value.creationRunId) ? value.creationRunId : '';
}

export function isReferenceCreationInput(value: unknown): value is CreationRunInput {
  if (!isCreationRunInputShape(value)) return false;
  const stringArrays: readonly (keyof Pick<CreationRunInput, 'visibleFacts' | 'inferredFacts' | 'unknownFacts' | 'fidelityFocus'>)[] = ['visibleFacts', 'inferredFacts', 'unknownFacts', 'fidelityFocus'];
  const budget = value.correctionBudget;
  return value.visibleFacts.length > 0
    && value.inferredFacts.length > 0
    && value.unknownFacts.length > 0
    && value.fidelityFocus.length > 0
    && stringArrays.every((key) => (value[key] as readonly unknown[]).every(nonEmptyString))
    && nonEmptyString(value.creationRunId)
    && nonEmptyString(value.referenceFingerprint)
    && nonEmptyString(value.targetProject)
    && nonEmptyString(value.targetScene)
    && nonEmptyString(value.originalStage)
    && nonEmptyString(value.viewSemantics)
    && Number.isSafeInteger(budget.perStage)
    && budget.perStage >= 1
    && budget.perStage <= 3
    && Number.isSafeInteger(budget.total)
    && budget.total >= 1
    && budget.total <= 12;
}

export function isReferenceCreationNativeEntitySpecs(value: unknown): value is readonly ReferenceCreationNativeEntitySpec[] {
  return Array.isArray(value) && value.every((spec) => {
    if (!isRecord(spec) || !nonEmptyString(spec.mutationId) || !nonEmptyString(spec.name) || !isRecord(spec.components)) return false;
    if (!Object.entries(spec.components).every(([component, payload]) => nonEmptyString(component) && isRecord(payload))) return false;
    const parent = spec.parent;
    return parent === undefined || (typeof parent === 'number' && Number.isSafeInteger(parent) && parent >= 0);
  });
}

export function isReferenceCreationEvidenceEvent(value: unknown): value is {
  readonly kind: 'save-committed' | 'capture-committed' | 'stage-advanced';
  readonly stage?: string;
  readonly evidenceId?: string;
  readonly requestId?: string;
} {
  if (!isRecord(value)) return false;
  const optionalStrings = ['stage', 'evidenceId', 'requestId'];
  if (optionalStrings.some((key) => value[key] !== undefined && !nonEmptyString(value[key]))) return false;
  if (value.kind === 'save-committed') return nonEmptyString(value.requestId);
  if (value.kind === 'capture-committed') return nonEmptyString(value.stage) && nonEmptyString(value.evidenceId) && nonEmptyString(value.requestId);
  return value.kind === 'stage-advanced' && nonEmptyString(value.stage) && nonEmptyString(value.evidenceId);
}

export function isReferenceCreationVisualReviewFacts(value: unknown): value is CreationVisualReviewFacts {
  if (!validateCreationVisualReviewFacts(value) || !isRecord(value.renderer)) return false;
  const renderer = value.renderer;
  const optionalRendererKeys: readonly ('carrierId' | 'carrierKind' | 'runtimeId')[] = ['carrierId', 'carrierKind', 'runtimeId'];
  return optionalRendererKeys.every((key) => renderer[key] === undefined || nonEmptyString(renderer[key]));
}

export function isReferenceCreationFinalDimensions(value: unknown): value is Omit<ReferenceCreationFinalReport, 'creationRunId' | 'verdict' | 'uncompletedItems'> & { readonly uncompletedItems?: readonly string[] } {
  if (!isRecord(value)) return false;
  const dimensions = ['input', 'structure', 'persistence', 'play', 'visual', 'toolCompleteness'];
  const validValues = new Set(['pass', 'fail', 'unproven']);
  return dimensions.every((key) => validValues.has(String(value[key])))
    && (value.uncompletedItems === undefined
      || (Array.isArray(value.uncompletedItems) && value.uncompletedItems.every((item) => nonEmptyString(item))));
}

function validIssueGroup(value: unknown): value is ReferenceCreationIssueGroup {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.trim() === '' || !Array.isArray(value.issues) || value.issues.length === 0) return false;
  return value.issues.every((issue) => typeof issue === 'string' && issue.trim() !== '');
}

function validCorrectionCommand(value: unknown): value is GatewayCreationCommand {
  return isRecord(value)
    && nonEmptyString(value.kind)
    && nonEmptyString(value.requestId);
}

export function isReferenceCreationCorrection(value: unknown): value is ReferenceCreationCorrection {
  return isRecord(value)
    && typeof value.stage === 'string'
    && value.stage.trim() !== ''
    && validIssueGroup(value.issueGroup)
    && validCorrectionCommand(value.command);
}

function invalidCorrectionFailure(value: unknown): { readonly code: string; readonly stage: string; readonly hint: string } | undefined {
  if (isReferenceCreationCorrection(value)) return undefined;
  const record = isRecord(value) ? value : undefined;
  const stage = typeof record?.stage === 'string' && record.stage.trim() !== '' ? record.stage.trim() : 'correction-input';
  if (!validIssueGroup(record?.issueGroup)) return {
    code: 'correction-issue-group-invalid',
    stage,
    hint: 'a correction must contain exactly one non-empty issue group.',
  };
  if (!validCorrectionCommand(record?.command)) return {
    code: 'correction-command-invalid',
    stage,
    hint: 'a correction must contain one non-empty Gateway command kind.',
  };
  return {
    code: 'correction-input-invalid',
    stage,
    hint: 'a correction must contain a non-empty stage, issue group, and Gateway command.',
  };
}

function readCorrectionQuery(port: GatewayCreationPort):
  | { readonly ok: true; readonly value: CorrectionQueryFacts }
  | { readonly ok: false; readonly error: ReferenceCreationFailure } {
  if (port.query === undefined) {
    return { ok: false, error: failure('correction-query-unavailable', 'correction', 'the Gateway query owner is unavailable; correction facts cannot be proven.', ['editor.query']) };
  }
  let result: GatewayCreationQueryResult;
  try {
    result = port.query({ with: ['Name'] });
  } catch (error) {
    return { ok: false, error: failure('correction-query-failed', 'correction', error instanceof Error ? error.message : 'the Gateway query owner rejected the correction pre-query.', ['editor.query']) };
  }
  if (!('rows' in result)) {
    return { ok: false, error: failure(result.error.code, 'correction', result.error.hint ?? result.error.code, ['editor.query']) };
  }
  if (!Array.isArray(result.rows)) {
    return { ok: false, error: failure('correction-query-invalid', 'correction', 'the Gateway query owner returned no typed rows for the correction facts.', ['editor.query']) };
  }
  const entityIds: number[] = [];
  const names: string[] = [];
  for (const row of result.rows) {
    if (!isRecord(row) || typeof row.entity !== 'number' || !Number.isSafeInteger(row.entity) || row.entity < 0) {
      return { ok: false, error: failure('correction-query-invalid', 'correction', 'the Gateway query owner returned a row without a valid EntityHandle.', ['editor.query']) };
    }
    entityIds.push(row.entity);
    if (isRecord(row.Name) && typeof row.Name.value === 'string') names.push(row.Name.value);
  }
  return {
    ok: true,
    value: Object.freeze({
      query: 'world.snapshot',
      with: ['Name'] as const,
      rowCount: result.rows.length,
      entityIds: Object.freeze(entityIds.sort((left, right) => left - right)),
      names: Object.freeze(names.sort()),
    }),
  };
}

function deriveCorrectionJudgment(pre: CorrectionQueryFacts, post: CorrectionQueryFacts): CorrectionStageJudgment | undefined {
  if (!Number.isSafeInteger(pre.rowCount) || !Number.isSafeInteger(post.rowCount)) return undefined;
  const sameFacts = pre.rowCount === post.rowCount
    && JSON.stringify(pre.entityIds) === JSON.stringify(post.entityIds)
    && JSON.stringify(pre.names) === JSON.stringify(post.names);
  if (post.rowCount > pre.rowCount) {
    return { status: 'improved', reason: 'post-query observed more authored rows than the pre-query.', preRowCount: pre.rowCount, postRowCount: post.rowCount };
  }
  if (post.rowCount < pre.rowCount) {
    return { status: 'degraded', reason: 'post-query observed fewer authored rows than the pre-query.', preRowCount: pre.rowCount, postRowCount: post.rowCount };
  }
  return {
    status: sameFacts ? 'unchanged' : 'changed',
    reason: sameFacts ? 'post-query facts are stable and the correction is recorded as evidence.' : 'post-query observed a typed fact change at the same row cardinality.',
    preRowCount: pre.rowCount,
    postRowCount: post.rowCount,
  };
}

function deriveFinalDimensions(state: CreationRunState): Omit<ReferenceCreationFinalReport, 'creationRunId' | 'verdict' | 'uncompletedItems'> {
  const inputBlocked = state.records.some((record) => record.kind === 'input-blocked');
  const input = inputBlocked ? 'fail' : state.records.some((record) => record.kind === 'run-created') ? 'pass' : 'unproven';
  const nativeEntities = state.nativeEntities.length > 0 && state.nativeEntities.every((entity) => entity.operationRunId.length > 0);
  const structure = nativeEntities && state.q5Mutation !== undefined ? 'pass' : 'unproven';
  const persistence = state.records.some((record) => record.kind === 'save-committed' && record.terminalStatus === 'succeeded' && typeof record.operationRunId === 'string')
    ? 'pass'
    : 'unproven';
  const hasPlayCapture = state.records.some((record) => record.kind === 'capture-committed' && record.stage === 'play-roundtrip');
  const play = persistence === 'pass' && hasPlayCapture ? 'pass' : 'unproven';
  const visualReviews = state.visualReviews ?? [];
  const expectedVisualReviews = ['edit-prop-after-reopen', 'play-prop-roundtrip'] as const;
  const hasAllVisualReviews = expectedVisualReviews.every((expectation) => visualReviews.some((review) => review.expectation === expectation));
  const visual = visualReviews.some((review) => review.verdict === 'fail')
    ? 'fail' as const
    : !hasAllVisualReviews || creationRunVisualReviewStatus(state) === 'unproven'
      ? 'unproven' as const
      : 'pass' as const;
  const hasEditCapture = state.records.some((record) => record.kind === 'capture-committed' && record.stage === 'edit-after-reopen');
  const toolCompleteness = input === 'pass' && structure === 'pass' && persistence === 'pass' && play === 'pass' && hasEditCapture
    ? 'pass'
    : 'unproven';
  return { input, structure, persistence, play, visual, toolCompleteness };
}

function evidenceProvenance(
  state: CreationRunState,
  stage: string,
  operationRunId?: string,
  capture?: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const facts = creationRunProvenance(state);
  return Object.freeze({
    sourceSequences: facts.sourceSequences,
    operationRunIds: Object.freeze([
      ...facts.operationRunIds,
      ...(operationRunId === undefined ? [] : [operationRunId]),
    ]),
    stage,
    ...(capture === undefined ? {} : capture),
    ...(facts.capabilityGeneration === undefined ? {} : { capabilityGeneration: facts.capabilityGeneration }),
  });
}

function captureArtifact(value: unknown): GatewayCaptureArtifact | undefined {
  if (!isCreationRunCaptureArtifact(value) || !isCreationCaptureProvenance((value as Record<string, unknown>).provenance)) return undefined;
  const candidate = value;
  return Object.freeze({
    runId: candidate.runId,
    tapePath: candidate.tapePath,
    reportPath: candidate.reportPath,
    provenance: (value as Record<string, unknown>).provenance as CreationCaptureProvenance,
  });
}

function isTerminalOperationRun(result: GatewayCreationRunResult): boolean {
  return result.ok && result.value.status !== 'accepted' && result.value.status !== 'running';
}

async function resolveTerminalOperationRun(
  gateway: GatewayCreationPort,
  requestId: string,
): Promise<GatewayCreationRunResult> {
  const observed = gateway.getOperationRunResult?.(requestId);
  if (observed !== undefined && isTerminalOperationRun(observed)) return observed;
  return gateway.waitOperationRun(requestId);
}

function hasEvidence(state: CreationRunState, kind: string, stage?: string): boolean {
  return state.records.some((record) => record.kind === kind && (stage === undefined || record.stage === stage));
}

function reconnectGateway(port: GatewayCreationPort, previousCapabilityGeneration: string): void {
  if (port.reconnect !== undefined) {
    port.reconnect(previousCapabilityGeneration);
    return;
  }
  const carrier = port as GatewayCreationPort & { readonly reconnectCapabilitySnapshot?: (previousCapabilityGeneration: string) => unknown };
  carrier.reconnectCapabilitySnapshot?.(previousCapabilityGeneration);
}

function selectNativeSeed(port: GatewayCreationPort, creationRunId: string): GatewayCreationCommand | undefined {
  const descriptors = port.listOps();
  const spawn = descriptors.find((entry) => operationAvailable(entry) && hasOperationRun(entry) && entry.id === 'spawnEntity');
  if (spawn !== undefined) {
    return {
      kind: spawn.id,
      name: 'Reference Seed',
      components: {},
      requestId: `${creationRunId}:native-seed`,
    };
  }
  const descriptor = descriptors.find((entry) => operationAvailable(entry) && hasOperationRun(entry) && entry.id === 'addSceneAssetToScene');
  const scene = port.assetCatalog().find((entry) => entry.kind === 'scene');
  if (descriptor !== undefined && scene !== undefined) {
    return {
      kind: descriptor.id,
      sceneGuid: scene.guid,
      name: scene.name ?? 'Reference Seed',
      requestId: `${creationRunId}:native-seed`,
    };
  }
  return undefined;
}

function gapFrom(
  blocked: GatewayOperationDescriptor | undefined,
  error: GatewayCreationError | undefined,
): CapabilityGapError | undefined {
  const generation = error?.capabilityGeneration ?? blocked?.capabilityGeneration;
  if (generation === undefined || generation.trim() === '') return undefined;
  const owner = error?.owner ?? blocked?.owner ?? blocked?.blocked?.owner ?? '@forgeax/editor-core OperationRun/applier contract owner';
  const diagnosticId = error?.diagnosticId ?? blocked?.blocked?.diagnosticId ?? 'q5-create-asset-terminal-run';
  const recoveryAction = error?.recoveryAction ?? blocked?.blocked?.recoveryAction ?? CREATION_NEXT_STEP_OWNER_REPAIR;
  const gap = capabilityGapError({
    capabilityId: 'scene.createAsset',
    capabilityGeneration: generation,
    stage: 'preflight',
    owner,
    expected: error?.expected === undefined ? 'request-correlated terminal OperationRun' : String(error.expected),
    recoveryAction,
    diagnosticId,
  });
  return Object.freeze({
    ...gap,
    ...(error?.hint === undefined ? {} : { hint: error.hint }),
    ...(error?.retryable === undefined ? {} : { retryable: error.retryable }),
    ...(error?.recoveryActions === undefined ? {} : { recoveryActions: Object.freeze([...error.recoveryActions]) }),
    ...(error?.source === undefined ? {} : { source: error.source }),
  }) as CapabilityGapError;
}

export class ReferenceCreationRuntime {
  readonly kernel: CreationRunKernel;
  private readonly gateway: GatewayCreationPort;
  readonly journalError?: ReferenceCreationFailure;

  constructor(options: ReferenceCreationRuntimeOptions) {
    this.gateway = options.gateway;
    this.kernel = new CreationRunKernel(options.journal);
    const journalError = options.journal?.validationError();
    this.journalError = options.journalError ?? (journalError === undefined
      ? undefined
      : journalRecoveryFailure(journalError.hint, journalError.details));
  }

  skill(): ReferenceCreationSkillDescriptor {
    return createReferenceCreationSkill(() => this.gateway.listOps());
  }

  preflight(input: CreationRunInput): { readonly ok: false; readonly error: ReferenceCreationFailure } | { readonly ok: true; readonly value: ReferenceCreationSkillDescriptor } {
    if (this.journalError !== undefined) return { ok: false, error: this.journalError };
    if (!isCreationRunInputShape(input)) return { ok: false, error: failure('creation-input-invalid', 'preflight', 'creation input must use the typed reference-creation shape.', ['creation.input.review']) };
    if (input.creationRunId.trim() === '' || input.referenceFingerprint.trim() === '' || input.viewSemantics.trim() === ''
      || input.targetProject.trim() === '' || input.targetScene.trim() === '' || input.originalStage.trim() === ''
      || input.visibleFacts.length === 0 || input.inferredFacts.length === 0 || input.unknownFacts.length === 0 || input.fidelityFocus.length === 0) {
      return { ok: false, error: failure('creation-input-incomplete', 'preflight', 'reference fingerprint, view semantics, target boundary, visible facts, and fidelity focus are required.', ['creation.input.review']) };
    }
    if (input.targetProject.includes('..') || input.targetScene.includes('..')
      || input.visibleFacts.some((fact) => fact.trim() === '')
      || input.inferredFacts.some((fact) => fact.trim() === '')
      || input.unknownFacts.some((fact) => fact.trim() === '')
      || input.fidelityFocus.some((fact) => fact.trim() === '')
      || input.correctionBudget.perStage < 1 || input.correctionBudget.perStage > 3
      || input.correctionBudget.total < 1 || input.correctionBudget.total > 12
      || !isReferenceCreationInput(input)) {
      return { ok: false, error: failure('creation-input-invalid', 'preflight', 'the target boundary, uncertainty facts, and bounded correction budget are invalid.', ['creation.input.review']) };
    }
    if (selectNativeSeed(this.gateway, input.creationRunId) === undefined) {
      return { ok: false, error: failure('capability-missing', 'preflight', 'a terminal native seed operation is unavailable: addSceneAssetToScene or spawnEntity.', ['editor.discover']) };
    }
    return { ok: true, value: this.skill() };
  }

  async start(input: CreationRunInput): Promise<ReferenceCreationResult> {
    const checked = this.preflight(input);
    if (!checked.ok) return { ok: false, error: checked.error, run: this.emptyRun(safeCreationRunId(input)) };
    const begun = this.kernel.begin(input);
    if (!begun.ok) return { ok: false, error: begun.error, run: begun.value };
    if (begun.value.records.length > 1) {
      return {
        ok: false,
        error: failure('creation-run-resume-required', 'preflight', 'an existing creation run can only continue through resume or owner repair; start cannot replay prior mutations.', ['creation.run.resume']),
        run: begun.value,
      };
    }
    if (begun.value.status === 'blocked') return { ok: false, error: failure('creation-run-blocked', 'preflight', 'the original creation run is already blocked; resume it after owner repair.', ['owner.repair']), run: begun.value };

    const seed = selectNativeSeed(this.gateway, input.creationRunId);
    if (seed === undefined) {
      const run = this.kernel.state(input.creationRunId)!;
      return { ok: false, error: failure('native-seed-unavailable', 'preflight', 'listOps() and asset discovery did not expose an available terminal native seed.', ['editor.discover']), run };
    }

    const accepted = this.gateway.dispatch(seed, 'ai');
    const acceptedRun = acceptedOperationRun(accepted);
    if (!accepted.ok || acceptedRun === undefined) {
      const run = this.kernel.state(input.creationRunId)!;
      return {
        ok: false,
        error: accepted.ok
          ? failure('native-seed-not-accepted', 'dispatch', 'the native seed did not return an OperationRun.', ['run.get'])
          : gatewayFailure(accepted.error, 'dispatch', ['run.get']),
        run,
      };
    }
    const terminal = await this.gateway.waitOperationRun(acceptedRun.requestId);
    if (!terminal.ok || terminal.value.status !== 'succeeded') {
      const run = this.kernel.state(input.creationRunId)!;
      return {
        ok: false,
        error: terminal.ok
          ? failure('native-seed-not-terminal-success', 'wait', `native seed ended in ${terminal.value.status}.`, ['run.get'])
          : gatewayFailure(terminal.error, 'wait', ['run.get']),
        run,
      };
    }

    const committed = this.kernel.append({
      creationRunId: input.creationRunId,
      kind: 'native-seed-committed',
      mutationId: `${input.creationRunId}:native-seed`,
      operationRunId: terminal.value.runId,
      terminalStatus: terminal.value.status,
      dispatchCount: 1,
      commitCount: 1,
      mutationCount: 1,
      originalStage: input.originalStage,
    });

    const createAsset = this.gateway.dispatch({
      kind: 'createAsset',
      packPath: `${input.targetProject}/assets/reference-creation.pack.json`,
      guid: `${input.creationRunId}:asset`,
      assetKind: 'scene',
      name: 'Reference Creation Asset',
    }, 'ai');
    if (createAsset.ok) {
      return {
        ok: false,
        error: failure('q5-owner-not-blocked', 'preflight', 'the M2 createAsset owner unexpectedly exposed a callable path; M2 requires the current red contract.', ['owner.adjudicate']),
        run: committed,
      };
    }

    const gap = gapFrom(blockedDescriptor(this.gateway), createAsset.error);
    if (gap === undefined) {
      const run = this.kernel.state(input.creationRunId)!;
      return {
        ok: false,
        error: failure('capability-generation-unavailable', 'preflight', 'the blocked capability did not publish an authoritative capability generation; owner adjudication is required before retry.', ['owner.adjudicate']),
        run,
      };
    }
    const blocked = this.kernel.append({
      creationRunId: input.creationRunId,
      kind: 'q5-gap-blocked',
      capabilityId: gap.capabilityId,
      originalStage: input.originalStage,
      capabilityGeneration: gap.capabilityGeneration,
      priorOperationRunId: terminal.value.runId,
      owner: gap.owner,
      diagnosticId: gap.diagnosticId,
      nextStep: gap.recoveryAction,
      code: gap.code,
      expected: gap.expected,
    });
    return { ok: false, error: gap, run: blocked };
  }

  resume(creationRunId: string): { readonly ok: true; readonly value: CreationRunState } | { readonly ok: false; readonly error: ReferenceCreationFailure } {
    if (this.journalError !== undefined) return { ok: false, error: this.journalError };
    const state = this.kernel.state(creationRunId);
    if (state === undefined) return { ok: false, error: failure('creation-run-not-found', 'preflight', `creation run "${creationRunId}" is not known.`, ['creation.run.list']) };
    return { ok: true, value: state };
  }

  async ownerRepairAndResume(creationRunId: string): Promise<ReferenceCreationResult> {
    if (this.journalError !== undefined) return { ok: false, error: this.journalError, run: this.emptyRun(creationRunId) };
    const state = this.kernel.state(creationRunId);
    if (state === undefined) {
      return { ok: false, error: failure('creation-run-not-found', 'preflight', `creation run "${creationRunId}" is not known.`, ['creation.run.list']), run: this.emptyRun(creationRunId) };
    }
    if (state.q5Mutation !== undefined) return { ok: true, run: state };
    const gap = state.q5Gap;
    if (state.status !== 'blocked' || gap === undefined) {
      return { ok: false, error: failure('creation-run-not-repairable', 'preflight', 'owner repair requires the persisted M2 q5 blocked record.', ['creation.run.resume']), run: state };
    }
    if (state.currentStage !== gap.originalStage) {
      return {
        ok: false,
        error: failureWithFacts('creation-run-stage-mismatch', 'preflight', 'owner repair refuses a run that no longer points at its original stage.', gap, {
          expectedStage: gap.originalStage,
          currentStage: state.currentStage,
        }),
        run: state,
      };
    }
    if (state.dispatchCount !== 1 || state.commitCount !== 1 || state.mutationCount !== 1 || state.committedMutationIds.length !== 1 || state.priorOperationRunId !== gap.priorOperationRunId) {
      return {
        ok: false,
        error: failureWithFacts('creation-run-prior-mutation-changed', 'preflight', 'owner repair refuses a q5 record whose prior successful mutation counts or identity changed.', gap, {
          expectedDispatchCount: 1,
          expectedCommitCount: 1,
          expectedMutationCount: 1,
          actualDispatchCount: state.dispatchCount,
          actualCommitCount: state.commitCount,
          actualMutationCount: state.mutationCount,
          actualCommittedMutationIds: state.committedMutationIds,
        }),
        run: state,
      };
    }

    reconnectGateway(this.gateway, gap.capabilityGeneration);
    const repaired = blockedDescriptor(this.gateway);
    if (repaired === undefined || !operationAvailable(repaired) || repaired.capabilityGeneration === undefined || repaired.capabilityGeneration === gap.capabilityGeneration || !hasOperationRun(repaired)) {
      return {
        ok: false,
        error: failureWithFacts('capability-repair-unavailable', 'preflight', 'the repaired owner did not publish a new callable generation with an OperationRun contract.', gap, {
          actualCapabilityGeneration: repaired?.capabilityGeneration,
          actualAvailable: operationAvailable(repaired),
          actualOperationRun: hasOperationRun(repaired),
        }),
        run: state,
      };
    }
    const repairedGeneration = repaired.capabilityGeneration;

    const requestId = `${creationRunId}:q5-mutation`;
    const accepted = this.gateway.dispatch({
      kind: 'createAsset',
      packPath: `${state.targetProject}/assets/reference-creation.pack.json`,
      guid: `${creationRunId}:asset`,
      assetKind: 'scene',
      name: 'Reference Creation Asset',
      requestId,
    }, 'ai');
    const acceptedRun = acceptedOperationRun(accepted);
    if (!accepted.ok || acceptedRun === undefined) {
      return {
        ok: false,
        error: accepted.ok
          ? failureWithFacts('q5-mutation-not-accepted', 'dispatch', 'the repaired createAsset owner did not return an OperationRun.', gap, { requestId })
          : { ...failureWithFacts('q5-mutation-not-accepted', 'dispatch', accepted.error.hint ?? accepted.error.code, gap, { requestId }), ...gatewayFailure(accepted.error, 'dispatch', ['run.get']) },
        run: state,
      };
    }
    const terminal = await this.gateway.waitOperationRun(requestId);
    if (!terminal.ok || terminal.value.status !== 'succeeded') {
      return {
        ok: false,
        error: terminal.ok
          ? failureWithFacts('q5-mutation-not-terminal-success', 'wait', `q5 mutation ended in ${terminal.value.status}.`, gap, { requestId, operationRunId: acceptedRun.runId })
          : { ...failureWithFacts('q5-mutation-not-terminal-success', 'wait', terminal.error.hint ?? terminal.error.code, gap, { requestId, operationRunId: acceptedRun.runId }), ...gatewayFailure(terminal.error, 'wait', ['run.get']) },
        run: state,
      };
    }
    const repairedState = this.kernel.append({
      creationRunId,
      kind: 'q5-mutation-committed',
      mutationId: `${creationRunId}:q5-mutation`,
      operationRunId: terminal.value.runId,
      terminalStatus: terminal.value.status,
      capabilityGeneration: repairedGeneration,
      dispatchCount: 0,
      commitCount: 0,
      mutationCount: 1,
      originalStage: gap.originalStage,
    });
    return { ok: true, run: repairedState };
  }

  async createNativeEntities(
    creationRunId: string,
    specs: readonly ReferenceCreationNativeEntitySpec[],
  ): Promise<ReferenceCreationResult> {
    if (this.journalError !== undefined) return { ok: false, error: this.journalError, run: this.emptyRun(creationRunId) };
    if (!isReferenceCreationNativeEntitySpecs(specs)) return { ok: false, error: failure('invalid-reference-creation-input', 'preflight', 'native entity specifications must be a typed array of entity descriptors.', ['creation.input.review']), run: this.emptyRun(creationRunId) };
    const state = this.kernel.state(creationRunId);
    if (state === undefined) return { ok: false, error: failure('creation-run-not-found', 'preflight', `creation run "${creationRunId}" is not known.`, ['creation.run.list']), run: this.emptyRun(creationRunId) };
    if (state.q5Mutation === undefined) return { ok: false, error: failure('creation-run-not-resumed', 'preflight', 'native entity creation requires the original run to resume after owner repair.', ['creation.run.resume']), run: state };
    const descriptor = this.gateway.listOps().find((entry) => entry.id === 'spawnEntity');
    if (descriptor === undefined || !operationAvailable(descriptor) || !hasOperationRun(descriptor)) return { ok: false, error: failure('capability-missing', 'preflight', 'spawnEntity must publish a terminal OperationRun before authored creation.', ['editor.discover']), run: state };
    let current = state;
    for (const spec of specs) {
      const existing = current.nativeEntities.find((entity) => entity.mutationId === spec.mutationId);
      if (existing !== undefined) continue;
      const requestId = `${creationRunId}:entity:${spec.mutationId}`;
      const accepted = this.gateway.dispatch({
        kind: 'spawnEntity',
        requestId,
        name: spec.name,
        ...(spec.parent === undefined ? {} : { parent: spec.parent }),
        components: spec.components,
      }, 'ai');
      const acceptedRun = acceptedOperationRun(accepted);
      if (!accepted.ok || acceptedRun === undefined) {
        const error = accepted.ok
          ? failure('native-entity-not-accepted', 'dispatch', 'spawnEntity did not return an OperationRun.', ['run.get'])
          : gatewayFailure(accepted.error, 'dispatch', ['run.get']);
        return { ok: false, error: { ...error, details: { dispatchResult: accepted } }, run: current };
      }
      const terminal = await this.gateway.waitOperationRun(requestId);
      if (!terminal.ok || terminal.value.status !== 'succeeded') return {
        ok: false,
        error: terminal.ok
          ? failure('native-entity-not-terminal-success', 'wait', `spawnEntity ended in ${terminal.value.status}.`, ['run.get', 'operation.retry'])
          : gatewayFailure(terminal.error, 'wait', ['run.get', 'operation.retry']),
        run: current,
      };
      const result = terminal.value.result as { readonly created?: readonly unknown[] } | undefined;
      const entity = result?.created?.find((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
      if (entity === undefined) {
        return {
          ok: false,
          error: failure('native-entity-handle-missing', 'wait', 'spawnEntity succeeded without a valid EntityHandle; the native commit was not recorded.', ['operation.retry']),
          run: current,
        };
      }
      current = this.kernel.append({
        creationRunId,
        kind: 'native-entity-committed',
        mutationId: spec.mutationId,
        operationRunId: terminal.value.runId,
        terminalStatus: terminal.value.status,
        entity,
        name: spec.name,
        dispatchCount: 1,
        commitCount: 1,
        mutationCount: 1,
        stage: current.currentStage,
      });
    }
    return { ok: true, run: current };
  }

  async correct(
    creationRunId: string,
    correction: ReferenceCreationCorrection,
  ): Promise<ReferenceCreationResult> {
    if (this.journalError !== undefined) return { ok: false, error: this.journalError, run: this.emptyRun(creationRunId) };
    const state = this.kernel.state(creationRunId);
    if (state === undefined) return { ok: false, error: failure('creation-run-not-found', 'correction', `creation run "${creationRunId}" is not known.`, ['creation.run.list']), run: this.emptyRun(creationRunId) };
    const rawCorrection: unknown = correction;
    const correctionFailure = invalidCorrectionFailure(rawCorrection);
    if (correctionFailure !== undefined) {
      const invalid = this.kernel.append({
        creationRunId,
        kind: 'correction-failed',
        stage: correctionFailure.stage,
        issueGroupId: 'correction-input',
        issues: [correctionFailure.hint],
        code: correctionFailure.code,
        budgetConsumed: false,
      });
      return { ok: false, error: failure(correctionFailure.code, 'correction', correctionFailure.hint, ['creation.run.report']), run: invalid };
    }
    const issueGroup = validIssueGroup(correction.issueGroup)
      ? Object.freeze({
        id: correction.issueGroup.id.trim(),
        issues: Object.freeze(correction.issueGroup.issues.map((issue) => issue.trim())),
      })
      : undefined;
    if (issueGroup === undefined) {
      const invalid = this.kernel.append({
        creationRunId,
        kind: 'correction-failed',
        stage: correction.stage,
        issueGroupId: 'correction-input',
        issues: ['the correction must contain exactly one non-empty issue group'],
        code: 'correction-issue-group-invalid',
        budgetConsumed: false,
      });
      return { ok: false, error: failure('correction-issue-group-invalid', 'correction', 'a correction must contain exactly one non-empty issue group.', ['creation.run.report']), run: invalid };
    }
    const stageCount = state.correctionCountByStage[correction.stage] ?? 0;
    if (stageCount >= state.correctionBudget.perStage || state.totalCorrectionCount >= state.correctionBudget.total) {
      const exhausted = this.kernel.append({
        creationRunId,
        kind: 'uncompleted-item',
        item: issueGroup.id,
        reason: 'correction-budget-exhausted',
        stage: correction.stage,
        issueGroupId: issueGroup.id,
        issues: issueGroup.issues,
        budgetConsumed: false,
      });
      return { ok: false, error: failure('correction-budget-exhausted', 'correction', 'the bounded correction budget is exhausted; the run remains explicitly incomplete.', ['creation.run.report']), run: exhausted };
    }

    const preQuery = readCorrectionQuery(this.gateway);
    if (!preQuery.ok) {
      const failed = this.kernel.append({
        creationRunId,
        kind: 'correction-failed',
        stage: correction.stage,
        issueGroupId: issueGroup.id,
        issues: issueGroup.issues,
        code: preQuery.error.code,
        budgetConsumed: false,
      });
      return { ok: false, error: preQuery.error, run: failed };
    }
    const descriptor = this.gateway.listOps().find((entry) => entry.id === correction.command.kind);
    if (descriptor === undefined || !operationAvailable(descriptor) || !hasOperationRun(descriptor)) {
      const blocked = this.kernel.append({
        creationRunId,
        kind: 'correction-failed',
        stage: correction.stage,
        issueGroupId: issueGroup.id,
        issues: issueGroup.issues,
        code: 'capability-missing',
        budgetConsumed: false,
        preQuery: preQuery.value,
      });
      return { ok: false, error: failure('capability-missing', 'correction', `correction capability "${correction.command.kind}" is unavailable.`, ['editor.discover']), run: blocked };
    }
    const requestId = typeof correction.command.requestId === 'string' ? correction.command.requestId : `${creationRunId}:correction:${state.totalCorrectionCount + 1}`;
    const accepted = this.gateway.dispatch({ ...correction.command, requestId }, 'ai');
    const acceptedRun = acceptedOperationRun(accepted);
    if (!accepted.ok || acceptedRun === undefined || acceptedRun.requestId !== requestId || acceptedRun.runId.trim() === '') {
      const failed = this.kernel.append({
        creationRunId,
        kind: 'correction-failed',
        stage: correction.stage,
        issueGroupId: issueGroup.id,
        issues: issueGroup.issues,
        code: accepted.ok ? 'correction-not-accepted' : accepted.error.code,
        budgetConsumed: false,
        preQuery: preQuery.value,
      });
      return { ok: false, error: accepted.ok
        ? failure('correction-not-accepted', 'dispatch', 'correction did not return a correlated OperationRun.', ['run.get'])
        : gatewayFailure(accepted.error, 'dispatch', ['run.get']), run: failed };
    }
    const terminal = await this.gateway.waitOperationRun(requestId);
    if (!terminal.ok) {
      const failed = this.kernel.append({
        creationRunId,
        kind: 'correction-failed',
        stage: correction.stage,
        issueGroupId: issueGroup.id,
        issues: issueGroup.issues,
        code: terminal.error.code,
        budgetConsumed: true,
        preQuery: preQuery.value,
        operationRunId: acceptedRun.runId,
      });
      return { ok: false, error: gatewayFailure(terminal.error, 'wait', ['operation.retry', 'creation.run.report']), run: failed };
    }
    if (terminal.value.status !== 'succeeded' || terminal.value.requestId !== requestId || terminal.value.runId.trim() === '') {
      const code = terminal.value.status !== 'succeeded' ? `operation-${terminal.value.status}` : 'operation-request-mismatch';
      const failed = this.kernel.append({
        creationRunId,
        kind: 'correction-failed',
        stage: correction.stage,
        issueGroupId: issueGroup.id,
        issues: issueGroup.issues,
        code,
        budgetConsumed: true,
        preQuery: preQuery.value,
        operationRunId: acceptedRun.runId,
      });
      return { ok: false, error: failure('correction-not-terminal-success', 'wait', `correction ended in ${terminal.value.status}.`, ['operation.retry', 'creation.run.report']), run: failed };
    }
    const successfulTerminal = terminal.value;
    const postQuery = readCorrectionQuery(this.gateway);
    if (!postQuery.ok) {
      const failed = this.kernel.append({
        creationRunId,
        kind: 'correction-failed',
        stage: correction.stage,
        issueGroupId: issueGroup.id,
        issues: issueGroup.issues,
        code: postQuery.error.code,
        budgetConsumed: true,
        preQuery: preQuery.value,
        operationRunId: successfulTerminal.runId,
      });
      return { ok: false, error: postQuery.error, run: failed };
    }
    const stageJudgment = deriveCorrectionJudgment(preQuery.value, postQuery.value);
    if (stageJudgment === undefined) {
      const failed = this.kernel.append({
        creationRunId,
        kind: 'correction-failed',
        stage: correction.stage,
        issueGroupId: issueGroup.id,
        issues: issueGroup.issues,
        code: 'correction-stage-judgment-unresolved',
        budgetConsumed: true,
        preQuery: preQuery.value,
        postQuery: postQuery.value,
        operationRunId: successfulTerminal.runId,
      });
      return { ok: false, error: failure('correction-stage-judgment-unresolved', 'correction', 'typed pre-query and post-query facts did not produce a stage judgment.', ['creation.run.report']), run: failed };
    }
    const completed = this.kernel.append({
      creationRunId,
      kind: 'correction',
      stage: correction.stage,
      issueGroupId: issueGroup.id,
      issues: issueGroup.issues,
      operationRunId: successfulTerminal.runId,
      budgetConsumed: true,
      preQuery: preQuery.value,
      postQuery: postQuery.value,
      stageJudgment,
    });
    return { ok: true, run: completed };
  }

  async recordEvidence(
    creationRunId: string,
    event: { readonly kind: 'save-committed' | 'capture-committed' | 'stage-advanced'; readonly stage?: string; readonly evidenceId?: string; readonly requestId?: string },
  ): Promise<{ readonly ok: true; readonly run: CreationRunState } | { readonly ok: false; readonly error: ReferenceCreationFailure; readonly run: CreationRunState }> {
    if (this.journalError !== undefined) return { ok: false, error: this.journalError, run: this.emptyRun(creationRunId) };
    if (!isReferenceCreationEvidenceEvent(event)) return { ok: false, error: failure('invalid-reference-creation-input', 'preflight', 'evidence events must match their discriminated typed shape.', ['creation.input.review']), run: this.emptyRun(creationRunId) };
    const state = this.kernel.state(creationRunId);
    if (state === undefined) return { ok: false, error: failure('creation-run-not-found', 'finalize', `creation run "${creationRunId}" is not known.`, ['creation.run.list']), run: this.emptyRun(creationRunId) };
    if (state.status === 'blocked') return { ok: false, error: failure('creation-run-blocked', 'finalize', 'blocked creation runs cannot advance evidence before owner repair.', ['creation.run.resume']), run: state };
    if (event.kind === 'save-committed') {
      if (typeof event.requestId !== 'string' || event.requestId.length === 0) {
        return { ok: false, error: failure('evidence-terminal-run-required', 'preflight', 'save evidence requires a Gateway requestId so the runtime can read its terminal OperationRun.', ['run.get']), run: state };
      }
      if (state.records.some((record) => record.kind === 'save-committed')) {
        return { ok: false, error: failure('evidence-duplicate', 'finalize', 'save evidence is append-only and has already been recorded for this creation run.', ['creation.run.resume']), run: state };
      }
      if (!hasEvidence(state, 'stage-advanced')) {
        return { ok: false, error: failure('evidence-order-invalid', 'finalize', 'save evidence requires a validated native stage advance.', ['creation.run.resume']), run: state };
      }
      const terminal = await resolveTerminalOperationRun(this.gateway, event.requestId);
      if (!terminal.ok || terminal.value.status !== 'succeeded') {
        const failed = this.kernel.append({
          creationRunId,
          kind: 'evidence-failed',
          evidenceKind: event.kind,
          requestId: event.requestId,
          code: terminal.ok ? `operation-${terminal.value.status}` : terminal.error.code,
        });
        return { ok: false, error: failure('evidence-not-terminal-success', 'wait', terminal.ok ? `save ended in ${terminal.value.status}.` : terminal.error.hint ?? terminal.error.code, ['run.get', 'operation.retry']), run: failed };
      }
      if (terminal.value.requestId !== event.requestId || terminal.value.runId.trim() === '') {
        return { ok: false, error: failure('evidence-save-run-mismatch', 'wait', 'save evidence must use a non-empty terminal OperationRun with the requested identity.', ['run.get', 'operation.retry']), run: state };
      }
      if (terminal.value.operationId !== undefined && terminal.value.operationId !== 'saveDocToDisk') {
        return { ok: false, error: failure('evidence-save-operation-mismatch', 'wait', 'save evidence must come from the expected saveDocToDisk operation.', ['run.get', 'operation.retry']), run: state };
      }
      return {
        ok: true,
        run: this.kernel.append({
          creationRunId,
          kind: event.kind,
          requestId: event.requestId,
          operationRunId: terminal.value.runId,
          terminalStatus: terminal.value.status,
          terminalResult: terminal.value.result,
          evidenceId: event.evidenceId,
          provenance: evidenceProvenance(state, 'save', terminal.value.runId),
        }),
      };
    }
    if (event.kind === 'capture-committed') {
      if (typeof event.stage !== 'string' || event.stage.length === 0 || typeof event.evidenceId !== 'string' || event.evidenceId.length === 0 || typeof event.requestId !== 'string' || event.requestId.length === 0) {
        return { ok: false, error: failure('evidence-capture-incomplete', 'finalize', 'capture evidence requires a stage, evidenceId, and Gateway requestId.', ['capture.retry']), run: state };
      }
      if (!state.records.some((record) => record.kind === 'save-committed' && record.terminalStatus === 'succeeded')) {
        return { ok: false, error: failure('evidence-order-invalid', 'finalize', 'capture evidence cannot precede a terminal persisted save.', ['creation.run.resume']), run: state };
      }
      if (!hasEvidence(state, 'stage-advanced')) {
        return { ok: false, error: failure('evidence-order-invalid', 'finalize', 'capture evidence requires a validated stage advance.', ['creation.run.resume']), run: state };
      }
      if (event.stage === 'play-roundtrip' && !hasEvidence(state, 'capture-committed', 'edit-after-reopen')) {
        return { ok: false, error: failure('evidence-order-invalid', 'finalize', 'Play capture evidence must follow the Edit-after-reopen capture.', ['capture.retry']), run: state };
      }
      if (state.records.some((record) => record.kind === 'capture-committed' && record.stage === event.stage)) {
        return { ok: false, error: failure('evidence-duplicate', 'finalize', `capture evidence for stage "${event.stage}" is already recorded.`, ['creation.run.resume']), run: state };
      }
      const terminal = await resolveTerminalOperationRun(this.gateway, event.requestId);
      if (!terminal.ok || terminal.value.status !== 'succeeded') {
        return { ok: false, error: failure('evidence-not-terminal-success', 'wait', terminal.ok ? `capture ended in ${terminal.value.status}.` : terminal.error.hint ?? terminal.error.code, ['run.get', 'capture.retry']), run: state };
      }
      if (terminal.value.requestId !== event.requestId) {
        return { ok: false, error: failure('evidence-capture-run-mismatch', 'wait', 'capture evidence requestId must match the terminal Gateway OperationRun requestId.', ['run.get', 'capture.retry']), run: state };
      }
      if (terminal.value.runId.trim() === '') {
        return { ok: false, error: failure('evidence-capture-run-mismatch', 'wait', 'capture evidence requires a non-empty terminal Gateway OperationRun runId.', ['run.get', 'capture.retry']), run: state };
      }
      if (terminal.value.operationId !== 'captureFrame') {
        return { ok: false, error: failure('evidence-capture-operation-mismatch', 'wait', 'capture evidence must come from the expected Gateway captureFrame operation.', ['run.get', 'capture.retry']), run: state };
      }
      const artifact = captureArtifact(terminal.value.result);
      if (artifact === undefined) {
        return { ok: false, error: failure('evidence-capture-artifact-missing', 'wait', 'captureFrame terminal success did not provide its trusted artifact paths.', ['capture.retry']), run: state };
      }
      return {
        ok: true,
        run: this.kernel.append({
          creationRunId,
          ...event,
          operationRunId: terminal.value.runId,
          terminalStatus: terminal.value.status,
          artifact: { runId: artifact.runId, tapePath: artifact.tapePath, reportPath: artifact.reportPath },
          captureProvenance: artifact.provenance,
          provenance: evidenceProvenance(state, event.stage, terminal.value.runId, {
            requestId: event.requestId,
            operationId: terminal.value.operationId,
            artifactRunId: artifact.runId,
            captureProvenance: artifact.provenance,
          }),
        }),
      };
    }
    if (hasEvidence(state, 'stage-advanced')) {
      return { ok: false, error: failure('evidence-duplicate', 'finalize', 'stage advance is append-only and has already been recorded for this creation run.', ['creation.run.resume']), run: state };
    }
    if (state.q5Mutation === undefined || state.nativeEntities.length === 0
      || state.nativeEntities.some((entity) => entity.operationRunId.length === 0)
      || event.stage !== state.originalStage
      || event.evidenceId !== 'native-entities-committed') {
      return { ok: false, error: failure('evidence-provenance-unproven', 'finalize', 'stage advance requires the original stage, the canonical native evidence id, and terminal native entity facts.', ['creation.run.resume']), run: state };
    }
    return {
      ok: true,
      run: this.kernel.append({
        creationRunId,
        ...event,
        provenance: evidenceProvenance(state, event.stage),
      }),
    };
  }

  appendVisualReview(
    creationRunId: string,
    facts: CreationVisualReviewFacts,
  ): { readonly ok: true; readonly run: CreationRunState } | { readonly ok: false; readonly error: ReferenceCreationFailure; readonly run: CreationRunState } {
    if (this.journalError !== undefined) return { ok: false, error: this.journalError, run: this.emptyRun(creationRunId) };
    if (!isReferenceCreationVisualReviewFacts(facts)) return { ok: false, error: failure('invalid-reference-creation-input', 'preflight', 'visual review facts must be Verify-authored typed facts.', ['creation.input.review']), run: this.emptyRun(creationRunId) };
    const result = this.kernel.appendVisualReview(creationRunId, facts);
    if (result.ok) return { ok: true, run: result.value };
    return {
      ok: false,
      error: failure(result.error.code, 'finalize', result.error.hint, [...result.error.recoveryActions]),
      run: result.value,
    };
  }

  finalize(creationRunId: string, dimensions: Omit<ReferenceCreationFinalReport, 'creationRunId' | 'verdict' | 'uncompletedItems'> & { readonly uncompletedItems?: readonly string[] }): { readonly ok: true; readonly report: ReferenceCreationFinalReport; readonly run: CreationRunState } | { readonly ok: false; readonly error: ReferenceCreationFailure; readonly run: CreationRunState } {
    if (this.journalError !== undefined) return { ok: false, error: this.journalError, run: this.emptyRun(creationRunId) };
    if (!isReferenceCreationFinalDimensions(dimensions)) return { ok: false, error: failure('invalid-reference-creation-input', 'preflight', 'final dimensions must use the typed reference-creation status shape.', ['creation.input.review']), run: this.emptyRun(creationRunId) };
    const state = this.kernel.state(creationRunId);
    if (state === undefined) return { ok: false, error: failure('creation-run-not-found', 'finalize', `creation run "${creationRunId}" is not known.`, ['creation.run.list']), run: this.emptyRun(creationRunId) };
    if (state.records.some((record) => record.kind === 'final-report')) {
      return { ok: false, error: failure('final-report-duplicate', 'finalize', 'a final report is already persisted for this creation run.', ['creation.run.resume']), run: state };
    }
    if (!hasEvidence(state, 'stage-advanced') || !hasEvidence(state, 'save-committed')
      || !hasEvidence(state, 'capture-committed', 'edit-after-reopen')
      || !hasEvidence(state, 'capture-committed', 'play-roundtrip')) {
      return { ok: false, error: failure('final-report-evidence-incomplete', 'finalize', 'final report requires validated native stage, save, Edit capture, and Play capture facts.', ['creation.run.resume']), run: state };
    }
    const derived = deriveFinalDimensions(state);
    const uncompletedItems = Object.freeze([...new Set([
      ...state.records.filter((record) => record.kind === 'uncompleted-item').map((record) => String(record.item ?? 'unknown')),
      ...(derived.visual === 'unproven' ? ['visual review pending'] : []),
    ])]);
    const required = [derived.input, derived.structure, derived.persistence, derived.play, derived.visual, derived.toolCompleteness];
    const verdict = uncompletedItems.length > 0 || required.includes('fail') ? 'fail' : required.includes('unproven') ? 'unproven' : 'pass';
    const report: ReferenceCreationFinalReport = Object.freeze({ creationRunId, ...derived, verdict, uncompletedItems });
    const run = this.kernel.append({ ...report, kind: 'final-report' });
    return { ok: true, report, run };
  }

  private emptyRun(creationRunId: string): CreationRunState {
    return {
      schemaVersion: 'reference-creation-run/v1',
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
      stageAdvanceCount: 0,
      committedMutationIds: [],
      status: 'blocked',
      nextStep: CREATION_NEXT_STEP_OWNER_REPAIR,
      records: [],
      nativeEntities: [],
    };
  }
}

function failureWithFacts(
  code: string,
  stage: ReferenceCreationFailure['stage'],
  hint: string,
  gap: CreationRunState['q5Gap'],
  facts: Record<string, unknown>,
): ReferenceCreationFailure {
  return {
    ...failure(code, stage, hint, ['owner.repair']),
    capabilityId: gap?.capabilityId,
    capabilityGeneration: gap?.capabilityGeneration,
    owner: gap?.owner,
    diagnosticId: gap?.diagnosticId,
    recoveryAction: gap?.nextStep,
    ...facts,
  };
}

export function createReferenceCreationRuntime(options: ReferenceCreationRuntimeOptions): ReferenceCreationRuntime {
  return new ReferenceCreationRuntime(options);
}

export function createReferenceCreationEntry(options: ReferenceCreationEntryOptions): ReferenceCreationEntry {
  let journalError: ReferenceCreationFailure | undefined;
  let persisted: readonly unknown[] = [];
  if (options.journal === undefined && options.journalStore !== undefined) {
    try {
      const decoded = decodePersistedJournal(options.journalStore.read());
      if (!decoded.ok) journalError = decoded.error;
      else persisted = decoded.records;
    } catch (error) {
      journalError = journalRecoveryFailure('persisted creation journal could not be read.', { cause: String(error) });
    }
  }
  const journal = options.journal ?? CreationRunJournal.fromRecords(persisted, {
    onAppend: (records) => options.journalStore?.write(records),
  });
  const runtime = createReferenceCreationRuntime({ gateway: options.gateway, journal, journalError });
  return {
    runtime,
    skill: () => runtime.skill(),
    journal: (creationRunId) => journal.listRecords(creationRunId),
    preflight: runtime.preflight.bind(runtime),
    start: runtime.start.bind(runtime),
    resume: runtime.resume.bind(runtime),
    ownerRepairAndResume: runtime.ownerRepairAndResume.bind(runtime),
    createNativeEntities: runtime.createNativeEntities.bind(runtime),
    correct: runtime.correct.bind(runtime),
    finalize: runtime.finalize.bind(runtime),
    recordEvidence: runtime.recordEvidence.bind(runtime),
    appendVisualReview: runtime.appendVisualReview.bind(runtime),
  };
}

export type { CreationRunInput, CreationRunState } from '../kernel/creation-run';
export type { CreationVisualReviewFacts } from '../kernel/run-journal';
export type { ReferenceCreationLifecycleRoute } from '../contracts/manifest';
export type ReferenceCreationInput = CreationRunInput;
export type ReferenceCreationReview = CreationVisualReviewFacts;
