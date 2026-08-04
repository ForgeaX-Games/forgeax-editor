import type { EditorProduct } from '../index';
import type { CommandError } from '../contracts/error';
import {
  TRANSPORT_PROTOCOL_VERSION,
  type TransportActor,
  type TransportError,
  type TransportPageResult,
  type TransportRequest,
  type TransportResponse,
} from '../contracts/transport';
import type { AssetLifecycleAdapter } from '../assets/preflight';
import type { AssetWorkspace, AssetWorkspaceInput, AssetWorkspaceObservation } from '../assets/workspace';
import { preflightAssetMutation, type AssetMutationRequest } from '../assets/preflight';
import { RunJournal } from '../kernel/run-journal';
import { reconcileRestartedRuns } from '../kernel/run-reconciliation';
import { recoverWorkflow } from '../kernel/workflow-recovery';
import type { WorkflowCoordinator } from '../kernel/workflow-coordinator';
import type { WorkflowRecipeRegistry } from '../kernel/workflow-recipes';
import type { WorkflowRecipe } from '../contracts/workflow';
import { isTerminalRunStatus, type OperationRunAcceptResult, type OperationRunReadResult, type SaveOperationRunPort } from '../contracts/run';
import { parseTransportMessage } from './protocol';
import { createEventCursor, decodeEventCursor } from './service-cursor';

export interface TransportSecurityPolicy {
  readonly version: typeof TRANSPORT_PROTOCOL_VERSION;
  readonly scopes: readonly string[];
  readonly permissions: Readonly<Record<string, 'read' | 'write' | 'execute'>>;
  readonly confirmationMethods: readonly string[];
}

export interface TransportAuthorizationRequest {
  readonly version: string;
  readonly method: string;
  readonly scope: string;
  readonly actor: TransportActor;
  readonly sessionId: string;
  readonly permission?: 'read' | 'write' | 'execute';
  readonly confirmationToken?: string;
  readonly cancel?: boolean;
  readonly timeoutMs?: number;
}

export type TransportAuthorizationResult = { readonly ok: true } | { readonly ok: false; readonly error: TransportError };

function securityError(code: string, hint: string, options: Partial<TransportError> = {}): TransportError {
  return Object.freeze({
    code,
    hint,
    retryable: false,
    recoveryActions: ['transport.describe'],
    ...options,
  });
}

export function createTransportSecurityPolicy(input: {
  readonly version: typeof TRANSPORT_PROTOCOL_VERSION;
  readonly scopes: readonly string[];
  readonly permissions: Readonly<Record<string, 'read' | 'write' | 'execute'>>;
  readonly confirmationMethods?: readonly string[];
}): TransportSecurityPolicy {
  return Object.freeze({
    version: input.version,
    scopes: Object.freeze([...input.scopes]),
    permissions: Object.freeze({ ...input.permissions }),
    confirmationMethods: Object.freeze([...(input.confirmationMethods ?? [])]),
  });
}

export function validateTransportScope(scope: string, policy: TransportSecurityPolicy): TransportAuthorizationResult {
  return policy.scopes.includes(scope)
    ? { ok: true }
    : { ok: false, error: securityError('scope-mismatch', 'request scope is not authorized for this carrier', { expected: { scopes: policy.scopes }, scope: { requested: scope, allowed: policy.scopes }, recoveryActions: ['transport.describe', 'scope.select'] }) };
}

export function authorizeTransportRequest(value: unknown, policy: TransportSecurityPolicy): TransportAuthorizationResult {
  if (value === null || typeof value !== 'object') return { ok: false, error: securityError('authorization-invalid', 'transport authorization fields are required') };
  const request = value as Partial<TransportAuthorizationRequest>;
  if (request.version !== policy.version) return { ok: false, error: securityError('protocol-bad-version', 'request uses an incompatible transport version', { expected: { version: policy.version }, compatibility: { supportedVersions: [policy.version] } }) };
  if (typeof request.actor?.id !== 'string' || request.actor.id.trim() === '' || typeof request.sessionId !== 'string' || request.sessionId.trim() === '') return { ok: false, error: securityError('authorization-invalid', 'actor and session identity are required') };
  const scopeResult = validateTransportScope(request.scope ?? '', policy);
  if (!scopeResult.ok) return scopeResult;
  const requiredPermission = policy.permissions[request.method ?? ''];
  if (requiredPermission !== undefined && request.permission !== requiredPermission) return {
    ok: false,
    error: securityError('permission-denied', 'request does not carry the required permission', { authorization: { requiredPermission, actorId: request.actor.id } }),
  };
  if (policy.confirmationMethods.includes(request.method ?? '') && !request.confirmationToken) return {
    ok: false,
    error: securityError('confirmation-required', 'explicit confirmation is required before this operation', { confirmation: { required: true, token: 'confirm:' + request.method }, recoveryActions: ['transport.confirm'] }),
  };
  if (request.cancel === true) return { ok: false, error: securityError('run-cancelled', 'the request was cancelled before mutation', { recoveryActions: ['run.get'] }) };
  if (request.timeoutMs !== undefined && (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0)) return { ok: false, error: securityError('invalid-timeout', 'timeoutMs must be a positive finite number') };
  return { ok: true };
}

export interface TransportCursorOptions {
  readonly limit: number;
  readonly cursor?: string;
  readonly snapshotRevision: string;
}

export function encodeTransportCursor(value: { readonly revision: string; readonly offset: number }): string {
  return 'cursor:' + encodeURIComponent(JSON.stringify(value));
}

export function decodeTransportCursor(value: string): { readonly revision: string; readonly offset: number } | null {
  if (!value.startsWith('cursor:')) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(value.slice(7))) as { revision?: unknown; offset?: unknown };
    return typeof parsed.revision === 'string' && typeof parsed.offset === 'number' && Number.isInteger(parsed.offset) && parsed.offset >= 0
      ? { revision: parsed.revision, offset: parsed.offset }
      : null;
  } catch { return null; }
}

export function paginateCollection<T>(items: readonly T[], options: TransportCursorOptions): TransportPageResult<T> {
  const limit = Math.max(1, Math.floor(options.limit));
  let offset = 0;
  if (options.cursor !== undefined) {
    const decoded = decodeTransportCursor(options.cursor);
    if (decoded === null) return { ok: false, items: [], snapshotRevision: options.snapshotRevision, error: securityError('cursor-invalid', 'cursor is malformed') };
    if (decoded.revision !== options.snapshotRevision) return { ok: false, items: [], snapshotRevision: options.snapshotRevision, error: securityError('cursor-revision-conflict', 'cursor belongs to a different snapshot revision') };
    offset = decoded.offset;
  }
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    ok: true,
    items: Object.freeze([...page]),
    snapshotRevision: options.snapshotRevision,
    ...(nextOffset < items.length ? { nextCursor: encodeTransportCursor({ revision: options.snapshotRevision, offset: nextOffset }) } : {}),
  };
}

export { createEventCursor, decodeEventCursor };

export function eventsAfterCursor<T extends { readonly sequence: number }>(events: readonly T[], cursor: string): readonly T[] {
  const decoded = decodeEventCursor(cursor);
  return decoded === null ? Object.freeze([]) : Object.freeze(events.filter((event) => event.sequence > decoded.sequence));
}

export function isTerminalTransportNotification(_value: unknown): false {
  return false;
}

export interface TransportServiceOptions {
  readonly product?: EditorProduct;
  /** The canonical workspace read model; no asset graph is created here. */
  readonly assetWorkspace?: AssetWorkspace;
  /** The canonical asset lifecycle seam owned by the host/gateway. */
  readonly assetLifecycle?: AssetLifecycleAdapter;
  /** Host-owned recovery seam for scoped asset restore operations. */
  readonly assetRestore?: (input: unknown, signal: AbortSignal) => unknown | Promise<unknown>;
  readonly journal?: RunJournal;
  /** Gateway-owned request-correlated save runs; transport only projects them. */
  readonly operationRuns?: SaveOperationRunPort;
  readonly security?: TransportSecurityPolicy;
  readonly dispatch?: (operationId: string, input: unknown, request: TransportAuthorizationRequest, signal?: AbortSignal) => unknown | Promise<unknown>;
  readonly query?: (input: unknown) => unknown | Promise<unknown>;
  /** Host-owned typed gameplay bridge for the same live Editor carrier. */
  readonly gameplay?: (input: unknown) => unknown | Promise<unknown>;
  readonly workflowCoordinator?: WorkflowCoordinator;
  readonly workflowRecipes?: WorkflowRecipeRegistry;
}

export interface TransportDiscoveryResult {
  readonly protocolVersion: typeof TRANSPORT_PROTOCOL_VERSION;
  readonly manifest: EditorProduct['manifest'] | null;
  readonly capabilityManifest: ReturnType<EditorProduct['discover']>['capabilityManifest'] | null;
  readonly availability: EditorProduct['availability'] | { readonly available: false; readonly blocking: true; readonly code: 'product-unavailable'; readonly hint: string; readonly issues: readonly string[] };
  readonly methods: readonly string[];
  readonly workflowRecipes: readonly { readonly id: string; readonly version: string }[];
}

export interface TransportService {
  handle(request: TransportRequest): Promise<TransportResponse>;
  handleLine(line: string): Promise<string>;
  getRun(runId: string): ReturnType<RunJournal['getRunResult']>;
  listEvents(runId: string): ReturnType<RunJournal['listEvents']>;
}

export type { SaveOperationRunPort } from '../contracts/run';
export type { TransportRequest } from '../contracts/transport';

type RunExecution = {
  readonly operationId: string;
  readonly input: unknown;
  readonly auth: TransportAuthorizationRequest;
};

type RunExecutionState = {
  readonly controller: AbortController;
  cancelled: boolean;
  completion?: Promise<unknown>;
};

function record(value: unknown): Record<string, unknown> {
  return isRecord(value)
    ? value as Record<string, unknown>
    : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isString);
}

const assetMutationOperations = new Set(['rename', 'move', 'delete', 'replace', 'duplicate', 'reimport', 'restore']);
const assetObservationKinds = new Set(['source-meta', 'guid-collision', 'malformed-package', 'revision-gap', 'asset-change', 'vcs-burst', 'late-root', 'event-gap', 'dirty-conflict']);
const assetSubjectKinds = new Set(['internal-asset', 'external-package', 'imported-output', 'source-dependency', 'derived-artifact', 'reference']);
const assetRelationKinds = new Set(['depends-on', 'referenced-by', 'contains', 'derived-from']);
const assetIssueCodes = new Set(['source-meta-pending', 'orphan-meta', 'source-only', 'guid-collision', 'malformed-package', 'dirty-conflict']);
const assetIssueSeverities = new Set(['info', 'warning', 'error']);

function isAssetMutationRequest(value: unknown): value is AssetMutationRequest {
  if (!isRecord(value) || !isString(value.operation) || !assetMutationOperations.has(value.operation) || !isString(value.subjectId)) return false;
  for (const key of ['expectedRevision', 'confirmationToken', 'scope', 'owner', 'idempotencyKey']) {
    if (value[key] !== undefined && !isString(value[key])) return false;
  }
  return true;
}

function isAssetWorkspaceObservation(value: unknown): value is AssetWorkspaceObservation {
  if (!isRecord(value) || !isString(value.kind) || !assetObservationKinds.has(value.kind)) return false;
  if (value.kind === 'source-meta') {
    if (!isString(value.sourcePath) || typeof value.sourcePresent !== 'boolean' || typeof value.metaPresent !== 'boolean' || !isString(value.logicalBatchId)) return false;
    if (value.meta === undefined) return true;
    const meta = value.meta;
    return isRecord(meta) && isStringArray(meta.subjectIds) && isRecord(meta.provenance) && isString(meta.provenance.owner) && isString(meta.provenance.source)
      && (meta.provenance.packageId === undefined || isString(meta.provenance.packageId));
  }
  if (value.kind === 'guid-collision') return isString(value.guid) && isStringArray(value.subjectIds) && isStringArray(value.paths);
  if (value.kind === 'malformed-package') return isString(value.packageId) && isString(value.path) && isString(value.reason);
  if (value.kind === 'revision-gap') return isString(value.rootId) && isString(value.scope) && isString(value.baselineRevision) && isString(value.currentRevision);
  if (value.kind === 'asset-change') return isString(value.rootId) && isString(value.scope) && isString(value.resourceRevision);
  if (value.kind === 'dirty-conflict') return isString(value.subjectId) && isString(value.expectedRevision) && isString(value.actualRevision);
  return isString(value.rootId) && isString(value.scope);
}

function isAssetWorkspaceInput(value: unknown): value is AssetWorkspaceInput {
  if (!isRecord(value) || !isString(value.resourceRevision) || !Array.isArray(value.subjects) || !Array.isArray(value.relations) || !Array.isArray(value.issues)) return false;
  if (value.logicalCommitId !== undefined && !isString(value.logicalCommitId)) return false;
  const subjectsValid = value.subjects.every((subject) => {
    if (!isRecord(subject) || !isString(subject.id) || !isString(subject.kind) || !assetSubjectKinds.has(subject.kind) || !isString(subject.resourceId) || !isString(subject.path)) return false;
    const provenance = subject.provenance;
    const capabilities = subject.capabilities;
    return isRecord(provenance) && isString(provenance.owner) && isString(provenance.source)
      && (provenance.packageId === undefined || isString(provenance.packageId))
      && isRecord(capabilities) && typeof capabilities.canImport === 'boolean' && typeof capabilities.canMove === 'boolean'
      && typeof capabilities.canDelete === 'boolean' && typeof capabilities.canPreflight === 'boolean';
  });
  const relationsValid = value.relations.every((relation) => isRecord(relation) && isString(relation.kind) && assetRelationKinds.has(relation.kind) && isString(relation.from) && isString(relation.to));
  const issuesValid = value.issues.every((entry) => isRecord(entry) && isString(entry.code) && assetIssueCodes.has(entry.code) && isString(entry.severity) && assetIssueSeverities.has(entry.severity) && isString(entry.message) && (entry.subjectId === undefined || isString(entry.subjectId)));
  return subjectsValid && relationsValid && issuesValid;
}

function invalidAssetInput(request: TransportRequest, method: string, expected: string): TransportResponse {
  return errorResponse(request, securityError('invalid-asset-input', `${method} params do not match the typed asset route contract.`, {
    expected: { method, shape: expected },
    recoveryActions: ['transport.describe'],
  }));
}

function commandError(value: unknown, fallback: CommandError): CommandError {
  const candidate = record(value);
  return typeof candidate.code === 'string' && typeof candidate.hint === 'string' && typeof candidate.retryable === 'boolean' && Array.isArray(candidate.recoveryActions)
    ? candidate as unknown as CommandError
    : fallback;
}

function failedResult(value: unknown): value is { readonly ok: false; readonly error?: unknown } {
  return value !== null && typeof value === 'object' && (value as { readonly ok?: unknown }).ok === false;
}

function productUnavailable(): TransportDiscoveryResult['availability'] {
  return {
    available: false,
    blocking: true,
    code: 'product-unavailable',
    hint: 'No EditorProduct is connected to this transport service.',
    issues: ['product-adapter-unavailable'],
  };
}

function requestAuth(request: TransportRequest, params: unknown): TransportAuthorizationRequest {
  const value = params !== null && typeof params === 'object' ? params as Record<string, unknown> : {};
  return {
    version: request.version,
    method: request.method,
    scope: request.scope,
    actor: value.actor as TransportActor ?? { id: 'transport-client', kind: 'ai' },
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : 'transport-session',
    permission: value.permission as TransportAuthorizationRequest['permission'],
    confirmationToken: typeof value.confirmationToken === 'string' ? value.confirmationToken : undefined,
    cancel: value.cancel === true,
    timeoutMs: typeof value.timeoutMs === 'number' ? value.timeoutMs : undefined,
  };
}

function terminalResponse(request: TransportRequest, result: unknown, runId?: string): TransportResponse {
  if (failedResult(result)) {
    return errorResponse(request, commandError(result.error, securityError('operation-failed', 'The transport operation returned a structured failure.')), runId);
  }
  return { jsonrpc: '2.0', version: TRANSPORT_PROTOCOL_VERSION, id: request.id, correlationId: request.correlationId, ...(runId === undefined ? {} : { runId }), result };
}

function errorResponse(request: TransportRequest, error: CommandError, runId?: string): TransportResponse {
  return { jsonrpc: '2.0', version: TRANSPORT_PROTOCOL_VERSION, id: request.id, correlationId: request.correlationId, ...(runId === undefined ? {} : { runId }), error };
}

export function createTransportService(options: TransportServiceOptions = {}): TransportService {
  const journal = options.journal ?? new RunJournal({ scope: 'default' });
  const security = options.security ?? createTransportSecurityPolicy({ version: TRANSPORT_PROTOCOL_VERSION, scopes: ['default'], permissions: {} });

  const active = new Map<string, RunExecutionState>();
  const activeWorkflows = new Map<string, Promise<unknown>>();

  function operationRunUnavailable(request: TransportRequest): TransportResponse {
    return errorResponse(request, securityError('executor-unavailable', 'No Gateway operation-run projection is connected.', { recoveryActions: ['editor.discover'] }));
  }

  function operationRunResponse(request: TransportRequest, result: OperationRunReadResult, requestId: string): TransportResponse {
    return result.ok ? terminalResponse(request, result.value, requestId) : errorResponse(request, result.error, requestId);
  }

  async function dispatchSave(
    request: TransportRequest,
    input: unknown,
    authInput: unknown = input,
    asynchronous = false,
  ): Promise<TransportResponse> {
    const requestId = record(input).requestId;
    if (typeof requestId !== 'string' || requestId.trim() === '') {
      return errorResponse(request, securityError('invalid-request-id', 'save requires a non-empty requestId.', { recoveryActions: ['transport.describe'] }));
    }
    const auth = requestAuth(request, authInput);
    const authorized = authorizeTransportRequest(auth, security);
    if (!authorized.ok) return errorResponse(request, authorized.error);
    const port = options.operationRuns;
    if (port === undefined) return operationRunUnavailable(request);
    const accepted: OperationRunAcceptResult = port.dispatchSave(requestId, input, auth.actor);
    if (!accepted.ok) return errorResponse(request, accepted.error);
    if (asynchronous) return terminalResponse(request, accepted.run, accepted.runId);
    const completed = await port.wait(requestId);
    return completed.ok
      ? terminalResponse(request, completed.value, accepted.runId)
      : errorResponse(request, completed.error, accepted.runId);
  }

  function discovery(): TransportDiscoveryResult {
    const product = options.product?.discover();
    return {
      protocolVersion: TRANSPORT_PROTOCOL_VERSION,
      manifest: product?.manifest ?? null,
      capabilityManifest: product?.capabilityManifest ?? null,
      availability: product?.availability ?? productUnavailable(),
      methods: Object.freeze([
        'discover', 'transport.describe', 'query', ...(options.gameplay === undefined ? [] : ['gameplay']), 'asset.snapshot', 'asset.observe', 'asset.reconcile', 'asset.preflight', 'asset.mutate', 'asset.restore', 'run.dispatch', 'run.get', 'run.wait',
        'run.list', 'run.listEvents', 'run.retry', 'run.cancel', 'run.reconcile',
        'workflow.start', 'workflow.get', 'workflow.recover', 'workflow.retry', 'workflow.listRecipes',
        'save', 'reopen',
      ]),
      workflowRecipes: Object.freeze((options.workflowRecipes?.list() ?? []).map((recipe) => ({ id: recipe.id, version: recipe.version }))),
    };
  }

  async function executeOperation(
    operationId: string,
    input: unknown,
    auth: TransportAuthorizationRequest,
    signal: AbortSignal,
  ): Promise<{ readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly error: CommandError }> {
    try {
      let value: unknown;
      if (options.dispatch !== undefined) value = await options.dispatch(operationId, input, auth, signal);
      else if (operationId === 'asset.mutate' && options.assetLifecycle !== undefined) value = await options.assetLifecycle.run(input as AssetMutationRequest);
      else if (operationId === 'asset.restore' && options.assetRestore !== undefined) value = await options.assetRestore(input, signal);
      else if (options.product !== undefined) {
        const executed = await options.product.capabilityRegistry.execute(operationId, input, { host: 'bun', signal });
        if (!executed.ok) return executed;
        value = executed.result;
      } else return { ok: false, error: securityError('executor-unavailable', 'no product executor is connected', { recoveryActions: ['editor.discover'] }) };
      if (failedResult(value)) {
        const error = commandError(value.error, securityError('operation-failed', 'The operation returned a structured failure.', { recoveryActions: ['run.retry'] }));
        return { ok: false, error };
      }
      return { ok: true, result: value };
    } catch (cause) {
      return { ok: false, error: securityError('operation-failed', cause instanceof Error ? cause.message : 'operation failed', { recoveryActions: ['run.retry'] }) };
    }
  }

  async function finishExecution(runId: string, execution: RunExecution): Promise<{ readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly error: CommandError }> {
    const state = active.get(runId) ?? { controller: new AbortController(), cancelled: false };
    const result = await executeOperation(execution.operationId, execution.input, execution.auth, state.controller.signal);
    active.delete(runId);
    if (state.cancelled || isTerminalRunStatus(journal.getRun(runId)?.status ?? 'accepted')) return result;
    if (result.ok) journal.append({ type: 'succeeded', runId, at: Date.now(), result: result.result });
    else journal.append({ type: 'failed', runId, at: Date.now(), error: result.error });
    return result;
  }

  function runStatus(request: TransportRequest, runId: string): TransportResponse {
    const run = journal.getRun(runId);
    return run === undefined
      ? errorResponse(request, securityError('run-not-found', `run "${runId}" is unknown.`, { recoveryActions: ['run.list'] }), runId)
      : terminalResponse(request, { runId, status: run.status }, runId);
  }

  async function runOperation(
    request: TransportRequest,
    operationId: string,
    input: unknown,
    authInput: unknown = input,
    runOptions: { readonly runId?: string; readonly parentRunId?: string; readonly attempt?: number; readonly idempotencyKey?: string; readonly asynchronous?: boolean } = {},
  ): Promise<TransportResponse> {
    const auth = requestAuth(request, authInput);
    const authorized = authorizeTransportRequest(auth, security);
    if (!authorized.ok) return errorResponse(request, authorized.error);
    const value = record(input);
    const accepted = journal.accept({
      runId: runOptions.runId ?? 'transport-' + request.id,
      operationId,
      actor: auth.actor,
      sessionId: auth.sessionId,
      scope: auth.scope,
      input,
      ...(runOptions.parentRunId === undefined ? {} : { parentRunId: runOptions.parentRunId }),
      ...(runOptions.attempt === undefined ? {} : { attempt: runOptions.attempt }),
      idempotencyKey: typeof value.idempotencyKey === 'string' ? value.idempotencyKey : undefined,
      ...(runOptions.idempotencyKey === undefined ? {} : { idempotencyKey: runOptions.idempotencyKey }),
      cancellable: true,
      retryable: true,
    });
    if (!accepted.ok) return errorResponse(request, accepted.error);
    if (accepted.reused) {
      const reused = journal.getRunResult(accepted.runId);
      return reused.ok && isTerminalRunStatus(reused.value.status)
        ? terminalResponse(request, reused.value, accepted.runId)
        : runStatus(request, accepted.runId);
    }
    const running = journal.append({ type: 'running', runId: accepted.runId, at: Date.now() });
    if (!running.ok) return errorResponse(request, running.error, accepted.runId);
    const controller = new AbortController();
    const execution = { operationId, input, auth } satisfies RunExecution;
    active.set(accepted.runId, { controller, cancelled: false });
    const completion = finishExecution(accepted.runId, execution);
    const state = active.get(accepted.runId);
    if (state !== undefined) state.completion = completion;
    if (runOptions.asynchronous === true) return runStatus(request, accepted.runId);
    const result = await completion;
    if (!result.ok) return errorResponse(request, result.error, accepted.runId);
    const terminal = journal.getRunResult(accepted.runId);
    return terminal.ok
      ? terminalResponse(request, terminal.value, accepted.runId)
      : errorResponse(request, terminal.error, accepted.runId);
  }

  async function runRetry(request: TransportRequest, params: Record<string, unknown>): Promise<TransportResponse> {
    const runId = typeof params.runId === 'string' ? params.runId : '';
    const original = journal.getRun(runId);
    if (original === undefined) return errorResponse(request, securityError('run-not-found', `run "${runId}" is unknown.`, { recoveryActions: ['run.list'] }), runId);
    if (original.status !== 'failed' || !original.retryable) return errorResponse(request, securityError('run-not-retryable', 'Only failed retryable runs can create a new attempt.', { recoveryActions: ['run.get'] }), runId);
    const retryRunId = typeof params.retryRunId === 'string' ? params.retryRunId : `transport-${request.id}`;
    const auth = {
      scope: original.scope,
      actor: original.actor,
      sessionId: original.sessionId,
      permission: 'execute' as const,
      ...(typeof params.confirmationToken === 'string' ? { confirmationToken: params.confirmationToken } : {}),
    };
    return runOperation(request, original.operationId, original.input, auth, {
      runId: retryRunId,
      parentRunId: original.runId,
      attempt: original.attempt + 1,
      idempotencyKey: `${original.idempotencyKey ?? original.runId}:attempt:${original.attempt + 1}`,
      asynchronous: params.async === true,
    });
  }

  function runCancel(request: TransportRequest, params: Record<string, unknown>): TransportResponse {
    const runId = typeof params.runId === 'string' ? params.runId : '';
    const run = journal.getRun(runId);
    if (run === undefined) return errorResponse(request, securityError('run-not-found', `run "${runId}" is unknown.`, { recoveryActions: ['run.list'] }), runId);
    if (isTerminalRunStatus(run.status)) return errorResponse(request, securityError('run-terminal', 'A terminal run cannot be cancelled.', { recoveryActions: ['run.get'] }), runId);
    if (!run.cancellable) return errorResponse(request, securityError('run-not-cancellable', 'The operation cannot be cancelled.', { recoveryActions: ['run.get'] }), runId);
    const state = active.get(runId);
    if (state) {
      state.cancelled = true;
      state.controller.abort();
    }
    const cancelled = journal.append({ type: 'cancelled', runId, at: Date.now(), error: securityError('run-cancelled', 'The run was cancelled by the client.', { recoveryActions: ['run.get'] }) });
    return cancelled.ok ? terminalResponse(request, cancelled.value, runId) : errorResponse(request, cancelled.error, runId);
  }

  function runList(request: TransportRequest, params: Record<string, unknown>): TransportResponse {
    const snapshotRevision = `journal:${journal.listRecords().length}`;
    const page = paginateCollection(journal.listRuns(), { limit: typeof params.limit === 'number' ? params.limit : 50, cursor: typeof params.cursor === 'string' ? params.cursor : undefined, snapshotRevision });
    return page.ok ? terminalResponse(request, page, undefined) : errorResponse(request, page.error);
  }

  function runEvents(request: TransportRequest, params: Record<string, unknown>): TransportResponse {
    const runId = typeof params.runId === 'string' ? params.runId : '';
    const events = service.listEvents(runId);
    const snapshotRevision = `events:${runId}:${events.at(-1)?.sequence ?? 0}`;
    const cursor = typeof params.cursor === 'string' ? decodeEventCursor(params.cursor) : undefined;
    if (params.cursor !== undefined && (cursor === null || cursor?.runId !== runId || cursor.snapshotRevision !== snapshotRevision)) {
      return errorResponse(request, securityError('cursor-revision-conflict', 'event cursor does not match the current run snapshot.', { recoveryActions: ['run.get', 'run.listEvents'] }), runId);
    }
    const after = cursor === undefined ? events : eventsAfterCursor(events, params.cursor as string);
    const limit = typeof params.limit === 'number' ? Math.max(1, Math.floor(params.limit)) : 100;
    const page = after.slice(0, limit);
    const last = page.at(-1)?.sequence ?? cursor?.sequence ?? 0;
    const nextCursor = page.length < after.length ? createEventCursor({ runId, snapshotRevision, sequence: last }) : undefined;
    return terminalResponse(request, { runId, snapshotRevision, events: page, ...(nextCursor === undefined ? {} : { nextCursor }) }, runId);
  }

  function workflowRequest(params: Record<string, unknown>, runId: string, scope: string): { runId: string; actor: TransportActor; sessionId: string; scope: string; input?: unknown; idempotencyKey?: string; attempt?: number; parentRunId?: string } {
    const actor = params.actor as TransportActor | undefined;
    return {
      runId,
      actor: actor ?? { id: 'transport-client', kind: 'ai' },
      sessionId: typeof params.sessionId === 'string' ? params.sessionId : 'transport-session',
      scope,
      ...(Object.prototype.hasOwnProperty.call(params, 'input') ? { input: params.input } : {}),
      ...(typeof params.idempotencyKey === 'string' ? { idempotencyKey: params.idempotencyKey } : {}),
    };
  }

  async function workflowStart(request: TransportRequest, params: Record<string, unknown>): Promise<TransportResponse> {
    const coordinator = options.workflowCoordinator;
    if (coordinator === undefined) return errorResponse(request, securityError('executor-unavailable', 'No WorkflowCoordinator is connected.', { recoveryActions: ['editor.discover'] }));
    const recipe = params.recipe as WorkflowRecipe | undefined ?? (typeof params.recipeId === 'string' ? options.workflowRecipes?.get(params.recipeId) : undefined);
    if (recipe === undefined) return errorResponse(request, securityError('workflow-recipe-unavailable', 'Provide a registered recipeId or an inline workflow recipe.', { recoveryActions: ['workflow.listRecipes'] }));
    const runId = typeof params.runId === 'string' ? params.runId : `workflow-${request.id}`;
    const started = coordinator.startWorkflow(recipe, workflowRequest(params, runId, request.scope));
    if (!started.ok) return errorResponse(request, started.error, runId);
    const completion = started.completion.finally(() => activeWorkflows.delete(started.runId));
    activeWorkflows.set(started.runId, completion);
    if (params.async === false) return terminalResponse(request, await completion, started.runId);
    return terminalResponse(request, { runId: started.runId, status: started.run.status, workflow: started.run }, started.runId);
  }

  function workflowGet(request: TransportRequest, params: Record<string, unknown>): TransportResponse {
    const runId = typeof params.runId === 'string' ? params.runId : '';
    const workflow = options.workflowCoordinator?.getWorkflow(runId);
    return workflow === undefined
      ? errorResponse(request, securityError('run-not-found', `workflow run "${runId}" is unknown.`, { recoveryActions: ['workflow.listRecipes'] }), runId)
      : terminalResponse(request, workflow, runId);
  }

  function workflowRetry(request: TransportRequest, params: Record<string, unknown>): TransportResponse {
    const coordinator = options.workflowCoordinator;
    const runId = typeof params.runId === 'string' ? params.runId : '';
    if (coordinator === undefined) return errorResponse(request, securityError('executor-unavailable', 'No WorkflowCoordinator is connected.', { recoveryActions: ['editor.discover'] }), runId);
    const result = coordinator.retryWorkflow(runId, typeof params.newRunId === 'string' ? params.newRunId : `workflow-${request.id}`);
    return result.ok
      ? terminalResponse(request, { runId: result.runId, status: result.run.status, workflow: result.run }, result.runId)
      : errorResponse(request, result.error, runId);
  }

  function workflowRecover(request: TransportRequest, params: Record<string, unknown>): TransportResponse {
    const coordinator = options.workflowCoordinator;
    const runId = typeof params.runId === 'string' ? params.runId : '';
    if (coordinator === undefined) return errorResponse(request, securityError('executor-unavailable', 'No WorkflowCoordinator is connected.', { recoveryActions: ['editor.discover'] }), runId);
    const action = params.action;
    if (action !== 'retry' && action !== 'continue' && action !== 'stop' && action !== 'compensate' && action !== 'require-confirmation') {
      return errorResponse(request, securityError('invalid-recovery-action', 'workflow recovery action is not recognized.', { recoveryActions: ['workflow.get'] }), runId);
    }
    const result = recoverWorkflow(coordinator, {
      action,
      runId,
      actionId: typeof params.actionId === 'string' ? params.actionId : '',
      ...(typeof params.newRunId === 'string' ? { newRunId: params.newRunId } : {}),
      ...(typeof params.confirmationToken === 'string' ? { confirmationToken: params.confirmationToken } : {}),
    });
    return result.ok ? terminalResponse(request, result, runId) : errorResponse(request, result.error, runId);
  }

  const service: TransportService = {
    async handle(request) {
      const declaredScope = record(request.params).scope;
      if (typeof declaredScope === 'string' && declaredScope !== request.scope) {
        return errorResponse(request, securityError('scope-mismatch', 'params scope does not match the transport routing scope.', {
          expected: { scope: request.scope },
          scope: { requested: declaredScope, allowed: [request.scope] },
          recoveryActions: ['transport.describe', 'scope.select'],
        }));
      }
      if (request.method === 'discover' || request.method === 'transport.describe') return terminalResponse(request, discovery());
      if (request.method === 'asset.snapshot') {
        const workspace = options.assetWorkspace;
        if (workspace === undefined) return errorResponse(request, securityError('executor-unavailable', 'No AssetWorkspace is connected.', { recoveryActions: ['editor.discover'] }));
        if (!isRecord(request.params)) return invalidAssetInput(request, request.method, '{ limit?: number, cursor?: string }');
        const params = record(request.params);
        const snapshot = workspace.snapshot();
        const page = paginateCollection(snapshot.subjects, { limit: typeof params.limit === 'number' ? params.limit : snapshot.subjects.length || 1, cursor: typeof params.cursor === 'string' ? params.cursor : undefined, snapshotRevision: snapshot.revision });
        return page.ok ? terminalResponse(request, { ...snapshot, subjects: page.items, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) }) : errorResponse(request, page.error);
      }
      if (request.method === 'asset.observe') {
        const workspace = options.assetWorkspace;
        if (workspace === undefined) return errorResponse(request, securityError('executor-unavailable', 'No AssetWorkspace is connected.', { recoveryActions: ['discover'] }));
        if (!isAssetWorkspaceObservation(request.params)) return invalidAssetInput(request, request.method, 'AssetWorkspaceObservation');
        return terminalResponse(request, workspace.observe(request.params));
      }
      if (request.method === 'asset.reconcile') {
        const workspace = options.assetWorkspace;
        if (workspace === undefined) return errorResponse(request, securityError('executor-unavailable', 'No AssetWorkspace is connected.', { recoveryActions: ['discover'] }));
        if (!isAssetWorkspaceInput(request.params)) return invalidAssetInput(request, request.method, 'AssetWorkspaceInput');
        return terminalResponse(request, workspace.reconcile(request.params));
      }
      if (request.method === 'asset.preflight') {
        const workspace = options.assetWorkspace;
        if (workspace === undefined) return errorResponse(request, securityError('executor-unavailable', 'No AssetWorkspace is connected.', { recoveryActions: ['editor.discover'] }));
        if (!isRecord(request.params)) return invalidAssetInput(request, request.method, '{ request?: AssetMutationRequest }');
        const params = record(request.params);
        const mutation = Object.prototype.hasOwnProperty.call(params, 'request') ? params.request : params;
        if (!isAssetMutationRequest(mutation)) return invalidAssetInput(request, request.method, 'AssetMutationRequest');
        const result = options.assetLifecycle?.preflight(mutation) ?? preflightAssetMutation(workspace.snapshot(), mutation);
        return terminalResponse(request, result);
      }
      if (request.method === 'asset.mutate') {
        if (!isRecord(request.params)) return invalidAssetInput(request, request.method, '{ request?: AssetMutationRequest, async?: boolean }');
        const params = record(request.params);
        const mutation = Object.prototype.hasOwnProperty.call(params, 'request') ? params.request : params;
        if (!isAssetMutationRequest(mutation)) return invalidAssetInput(request, request.method, 'AssetMutationRequest');
        return runOperation(request, 'asset.mutate', mutation, params, { asynchronous: params.async === true });
      }
      if (request.method === 'asset.restore') {
        if (!isRecord(request.params)) return invalidAssetInput(request, request.method, '{ input?: unknown, async?: boolean }');
        const params = record(request.params);
        const input = Object.prototype.hasOwnProperty.call(params, 'input') ? params.input : params;
        if (!isRecord(input)) return invalidAssetInput(request, request.method, '{ input?: object, async?: boolean }');
        return runOperation(request, 'asset.restore', input, params, { asynchronous: params.async === true });
      }
      if (request.method === 'run.get') {
        const params = record(request.params);
        const requestId = params.requestId;
        if (typeof requestId === 'string') {
          if (options.operationRuns === undefined) return operationRunUnavailable(request);
          return operationRunResponse(request, options.operationRuns.get(requestId), requestId);
        }
        const runId = String(params.runId ?? '');
        const result = journal.getRunResult(runId);
        return result.ok ? terminalResponse(request, result.value, runId) : errorResponse(request, result.error);
      }
      if (request.method === 'run.wait') {
        const params = record(request.params);
        const requestId = params.requestId;
        if (typeof requestId === 'string') {
          if (options.operationRuns === undefined) return operationRunUnavailable(request);
          return operationRunResponse(request, await options.operationRuns.wait(requestId), requestId);
        }
        const runId = String(params.runId ?? '');
        await active.get(runId)?.completion;
        await activeWorkflows.get(runId);
        const result = journal.getRunResult(runId);
        return result.ok ? terminalResponse(request, result.value, runId) : errorResponse(request, result.error);
      }
      if (request.method === 'run.listEvents') {
        return runEvents(request, record(request.params));
      }
      if (request.method === 'run.list') return runList(request, record(request.params));
      if (request.method === 'run.retry') {
        const params = record(request.params);
        if (typeof params.requestId === 'string') {
          if (options.operationRuns === undefined) return operationRunUnavailable(request);
          const auth = requestAuth(request, params);
          const authorized = authorizeTransportRequest(auth, security);
          if (!authorized.ok) return errorResponse(request, authorized.error);
          const original = options.operationRuns.get(params.requestId);
          if (!original.ok) return errorResponse(request, original.error, params.requestId);
          const retryRequestId = typeof params.retryRequestId === 'string' ? params.retryRequestId : `transport-${request.id}`;
          const retried = options.operationRuns.retry(params.requestId, retryRequestId, auth.actor);
          return retried.ok ? terminalResponse(request, retried.run, retried.runId) : errorResponse(request, retried.error);
        }
        return runRetry(request, params);
      }
      if (request.method === 'run.cancel') {
        const params = record(request.params);
        if (typeof params.requestId === 'string') {
          if (options.operationRuns === undefined) return operationRunUnavailable(request);
          const original = options.operationRuns.get(params.requestId);
          if (!original.ok) return errorResponse(request, original.error, params.requestId);
          const cancelled = options.operationRuns.cancel(params.requestId);
          return cancelled.ok ? terminalResponse(request, cancelled.value, params.requestId) : errorResponse(request, cancelled.error, params.requestId);
        }
        return runCancel(request, params);
      }
      if (request.method === 'run.reconcile') {
        const params = record(request.params);
        const reconciled = reconcileRestartedRuns(journal, { committedEffectKeys: new Set(Array.isArray(params.committedEffectKeys) ? params.committedEffectKeys.filter((key): key is string => typeof key === 'string') : []) });
        return terminalResponse(request, reconciled);
      }
      if (request.method === 'workflow.start') return workflowStart(request, record(request.params));
      if (request.method === 'workflow.get') return workflowGet(request, record(request.params));
      if (request.method === 'workflow.retry') return workflowRetry(request, record(request.params));
      if (request.method === 'workflow.recover') return workflowRecover(request, record(request.params));
      if (request.method === 'workflow.listRecipes') return terminalResponse(request, { recipes: options.workflowRecipes?.list() ?? [] });
      if (request.method === 'query') {
        const result = options.query === undefined ? { ok: true, value: undefined } : await options.query(request.params);
        return terminalResponse(request, result, undefined);
      }
      if (request.method === 'gameplay') {
        if (options.gameplay === undefined) return errorResponse(request, securityError('not-supported', 'No live gameplay bridge is connected.'));
        // Gameplay owns a distinct versioned success/failure envelope. Preserve
        // it as result data instead of reinterpreting ok:false as CommandError.
        return {
          jsonrpc: '2.0', version: TRANSPORT_PROTOCOL_VERSION,
          id: request.id, correlationId: request.correlationId,
          result: await options.gameplay(request.params),
        };
      }
      if (request.method === 'save') {
        const input = record(request.params);
        return typeof input.requestId === 'string'
          ? dispatchSave(request, input)
          : runOperation(request, 'saveDocToDisk', request.params);
      }
      if (request.method === 'reopen') return runOperation(request, 'reopenDocument', request.params);
      if (request.method === 'run.dispatch') {
        const params = record(request.params);
        const operationId = typeof params.operationId === 'string' ? params.operationId : 'unknown';
        const input = params.input;
        return operationId === 'saveDocToDisk' && typeof record(input).requestId === 'string'
          ? dispatchSave(request, input, params, params.async === true)
          : runOperation(request, operationId, input, params, {
            asynchronous: params.async === true,
            ...(typeof params.idempotencyKey === 'string' ? { idempotencyKey: params.idempotencyKey } : {}),
          });
      }
      return errorResponse(request, securityError('not-supported', 'transport method is not registered'));
    },
    async handleLine(line) {
      const parsed = parseTransportMessage(line);
      if (!parsed.ok || !('method' in parsed.value)) {
        const error = parsed.ok ? securityError('protocol-invalid-message', 'responses cannot be submitted to the request carrier') : parsed.error;
        return JSON.stringify({ jsonrpc: '2.0', version: TRANSPORT_PROTOCOL_VERSION, id: 'invalid', correlationId: 'invalid', error }) + '\n';
      }
      return JSON.stringify(await service.handle(parsed.value)) + '\n';
    },
    getRun(runId) { return journal.getRunResult(runId); },
    listEvents(runId) { return journal.listEvents(runId); },
  };
  return service;
}
