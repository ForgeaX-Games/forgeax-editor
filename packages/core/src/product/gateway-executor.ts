// Product capability adapter for the existing EditGateway.
//
// The gateway catalog remains the registration SSOT. This adapter only maps
// those descriptors into product contracts and sends execution back through
// gateway.dispatch; it does not create a second executor or action registry.

import {
  CapabilityRegistry,
  createEditorProduct,
  type CapabilityDescriptor,
  type CapabilityRegistration,
  type EditorProduct,
  type OperationRun,
  type OperationRunAcceptResult,
  type OperationRunReadResult,
  type OperationRunRequest,
  type SaveOperationRunPort,
  type RunActor,
  type RunJournalAcceptResult,
  type RunJournalEventInput,
} from '@forgeax/editor-product';
import { RunJournal } from '@forgeax/editor-product';
import type { ArgsSchema, GatewayOpDescriptor, GatewayOpSnapshot } from '../io/catalog';
import type { CommandOrigin } from '../io/gateway-history';
import type { EditorOp } from '../types';
import { awaitAssetWriteCompletion } from '../session/authored-asset-write';

export interface GatewayDispatchResult {
  readonly ok: boolean;
  readonly [key: string]: unknown;
}

export interface GatewayCapabilitySource {
  readonly listOps: () => readonly GatewayOpDescriptor[];
  readonly subscribeOps?: (listener: (snapshot: GatewayOpSnapshot) => void) => () => void;
  readonly dispatch?: (command: EditorOp, origin?: CommandOrigin) => GatewayDispatchResult;
  /** The Gateway-owned request-correlated run projection. */
  readonly operationRuns?: GatewayOperationRunPort;
}

export type GatewayOperationRunPort = Pick<SaveOperationRunPort, 'get' | 'wait' | 'subscribe' | 'cancel' | 'retry'>;

export type GatewayRunRequest = Omit<OperationRunRequest, 'operationId' | 'input' | 'runId'> & {
  readonly runId?: string;
};

export type GatewayRunResult = RunJournalAcceptResult;

export interface GatewayCapabilityAdapter {
  readonly registry: CapabilityRegistry;
  capabilities(): readonly CapabilityDescriptor[];
  product(): EditorProduct;
  dispose(): void;
  /** The product transport's save port; facts remain owned by the Gateway. */
  readonly saveOperationRuns: SaveOperationRunPort;
  acceptRun(operationId: string, input: unknown, request: GatewayRunRequest): GatewayRunResult;
  dispatchRun(operationId: string, input: unknown, request: GatewayRunRequest): GatewayRunResult;
  getRun(runId: string): OperationRun | undefined;
  listRunEvents(runId: string): readonly RunJournalEventInput[];
  updateRunProgress(runId: string, progress: { readonly fraction: number; readonly stage: string }): GatewayRunMutationResult;
  cancelRun(runId: string): GatewayRunMutationResult;
  failRun(runId: string, error: import('@forgeax/editor-product').CommandError): GatewayRunMutationResult;
  retryRun(runId: string, retryRunId: string): GatewayRunResult;
  getOperationRunResult(requestId: string): OperationRunReadResult;
  waitOperationRun(requestId: string): Promise<OperationRunReadResult>;
  subscribeOperationRun(requestId: string, listener: (run: OperationRun) => void): () => void;
  cancelOperationRun(requestId: string): OperationRunReadResult<never>;
  retryOperationRun(requestId: string, retryRequestId: string, actor?: RunActor): OperationRunAcceptResult;
}

export type GatewayRunMutationResult =
  | { readonly ok: true; readonly value: OperationRun }
  | { readonly ok: false; readonly error: import('@forgeax/editor-product').CommandError };

function argsSchemaToCapabilitySchema(schema: ArgsSchema | null): Record<string, unknown> | null {
  return schema === null ? null : { ...schema };
}

function gatewayAvailability(
  descriptor: GatewayOpDescriptor,
  hasExecutor: boolean,
): CapabilityRegistration['availability'] {
  if (!descriptor.availability.available) {
    return {
      available: false,
      code: 'executor-unavailable',
      reason: descriptor.availability.reason,
      resolution: descriptor.availability.resolution ?? 'Connect the Runtime owner that registers this operation.',
    };
  }
  if (hasExecutor) return { available: true };
  return {
    available: false,
    code: 'executor-unavailable',
    reason: `gateway executor for "${descriptor.id}" is not connected`,
    resolution: 'Provide an EditGateway dispatch adapter.',
  };
}

function operationRunFromGatewayResult(result: GatewayDispatchResult): OperationRun | undefined {
  const nested = result.result !== null && typeof result.result === 'object'
    ? result.result as Record<string, unknown>
    : undefined;
  const run = result.operationRun ?? nested?.operationRun;
  return run !== null && typeof run === 'object' ? run as OperationRun : undefined;
}

function replaceGatewayOperationRun(
  result: GatewayDispatchResult,
  run: OperationRun,
): GatewayDispatchResult {
  const nested = result.result !== null && typeof result.result === 'object'
    ? result.result as Record<string, unknown>
    : undefined;
  return nested === undefined
    ? { ...result, operationRun: run }
    : { ...result, result: { ...nested, operationRun: run } };
}

async function executeGatewayCommand(
  source: GatewayCapabilitySource,
  descriptor: GatewayOpDescriptor,
  input: unknown,
): Promise<GatewayDispatchResult> {
  const args = input !== null && typeof input === 'object'
    ? input as Record<string, unknown>
    : { value: input };
  const result = source.dispatch!({ kind: descriptor.id, ...args }, 'ai');
  if (!result.ok) return result;
  const completionGuid = descriptor.completion === undefined
    ? undefined
    : args[descriptor.completion.guidField];
  if (typeof completionGuid === 'string') {
    try {
      await awaitAssetWriteCompletion(completionGuid);
    } catch (cause) {
      return { ok: false, error: {
        code: descriptor.completion?.kind === 'asset-visible'
          ? 'asset-visibility-timeout'
          : 'asset-write-failed',
        hint: cause instanceof Error
          ? cause.message
          : `Created asset ${completionGuid} did not become visible in the live asset catalog.`,
        retryable: true,
        recoveryActions: descriptor.completion?.kind === 'asset-visible'
          ? ['editor.requestReimport', 'request.retry']
          : ['request.retry'],
      } };
    }
  }
  const accepted = operationRunFromGatewayResult(result);
  if (accepted === undefined) return result;
  if (accepted.status === 'succeeded') return result;
  if (accepted.status === 'failed' || accepted.status === 'cancelled') {
    return { ok: false, error: accepted.error ?? {
      code: 'operation-failed',
      hint: `Gateway operation "${descriptor.id}" ended ${accepted.status}.`,
      retryable: accepted.retryable,
      recoveryActions: accepted.recoveryActions,
    } };
  }
  if (source.operationRuns === undefined || typeof accepted.requestId !== 'string') {
    return { ok: false, error: {
      code: 'operation-run-unavailable',
      hint: `Gateway operation "${descriptor.id}" requires terminal run tracking.`,
      retryable: true,
      recoveryActions: ['run.wait', 'editor.discover'],
    } };
  }
  const completed = await source.operationRuns.wait(accepted.requestId);
  if (!completed.ok) return { ok: false, error: completed.error };
  if (completed.value.status !== 'succeeded') {
    return { ok: false, error: completed.value.error ?? {
      code: 'operation-failed',
      hint: `Gateway operation "${descriptor.id}" ended ${completed.value.status}.`,
      retryable: completed.value.retryable,
      recoveryActions: completed.value.recoveryActions,
    } };
  }
  return replaceGatewayOperationRun(result, completed.value);
}

function unavailableRunResult<T = OperationRun>(): OperationRunReadResult<T> {
  return {
    ok: false,
    error: {
      code: 'executor-unavailable',
      hint: 'The Gateway operation-run projection is not connected.',
      retryable: false,
      recoveryActions: ['editor.discover'],
    },
  };
}

function unavailableRunAccept(): OperationRunAcceptResult {
  return unavailableRunResult() as OperationRunAcceptResult;
}

function registrationFor(
  descriptor: GatewayOpDescriptor,
  source: GatewayCapabilitySource,
): CapabilityRegistration {
  const id = `editor.${descriptor.id}`;
  const hasExecutor = source.dispatch !== undefined && descriptor.availability.available;
  const registration: CapabilityRegistration = {
    id,
    kind: 'operation',
    version: 'editor-product/v1',
    subject: 'editor',
    verb: descriptor.id,
    inputSchema: argsSchemaToCapabilitySchema(descriptor.argsSchema),
    outputSchema: { type: 'object', description: 'Gateway dispatch result.' },
    availability: gatewayAvailability(descriptor, hasExecutor),
    preconditions: [],
    recoveryActions: ['editor.discover'],
    ...(hasExecutor
      ? { executor: { execute: (input: unknown) => executeGatewayCommand(source, descriptor, input) } }
      : {}),
  };
  return registration;
}

function populateRegistry(
  source: GatewayCapabilitySource,
  registry: CapabilityRegistry,
  descriptors: readonly GatewayOpDescriptor[],
): readonly string[] {
  const ids: string[] = [];
  for (const descriptor of descriptors) {
    registry.register(registrationFor(descriptor, source));
    ids.push(`editor.${descriptor.id}`);
  }
  return ids;
}

export function createGatewayCapabilityAdapter(
  source: GatewayCapabilitySource,
): GatewayCapabilityAdapter {
  const registry = new CapabilityRegistry();
  const descriptors = new Map<string, GatewayOpDescriptor>();
  let managedIds: readonly string[] = [];
  const syncCapabilities = (next: readonly GatewayOpDescriptor[] = source.listOps()): void => {
    for (const id of managedIds) registry.unregister(id);
    descriptors.clear();
    for (const descriptor of next) descriptors.set(descriptor.id, descriptor);
    managedIds = populateRegistry(source, registry, next);
  };
  syncCapabilities();
  const unsubscribeCapabilities = source.subscribeOps?.((snapshot) => syncCapabilities(snapshot.ops)) ?? (() => undefined);
  const journals = new Map<string, RunJournal>();
  let generatedRun = 0;
  const journalFor = (scope: string): RunJournal => {
    const existing = journals.get(scope);
    if (existing !== undefined) return existing;
    const journal = new RunJournal({ scope });
    journals.set(scope, journal);
    return journal;
  };
  const journalForRun = (runId: string): RunJournal | undefined => {
    for (const journal of journals.values()) if (journal.getRun(runId) !== undefined) return journal;
    return undefined;
  };
  const saveOperationRuns: SaveOperationRunPort = {
    dispatchSave(requestId, input, actor) {
      const descriptor = descriptors.get('saveDocToDisk');
      if (
        descriptor === undefined
        || !descriptor.availability.available
        || source.dispatch === undefined
        || source.operationRuns === undefined
      ) return unavailableRunAccept();
      const result = source.dispatch(
        {
          kind: 'saveDocToDisk',
          ...(input !== null && typeof input === 'object' ? input as Record<string, unknown> : { value: input }),
          requestId,
        },
        actor.kind === 'human' ? 'human' : 'ai',
      );
      if (!result.ok) {
        return {
          ok: false,
          error: (result.error as import('@forgeax/editor-product').CommandError | undefined) ?? {
            code: 'operation-failed',
            hint: 'The gateway save operation failed.',
            retryable: false,
            recoveryActions: [],
          },
        };
      }
      const resultRecord = result.result !== null && typeof result.result === 'object'
        ? result.result as Record<string, unknown>
        : undefined;
      const run = result.operationRun ?? resultRecord?.operationRun;
      if (run === null || typeof run !== 'object') return unavailableRunAccept();
      return {
        ok: true,
        runId: (run as OperationRun).runId,
        reused: false,
        run: run as OperationRun,
      };
    },
    get(requestId) {
      return source.operationRuns?.get(requestId) ?? unavailableRunResult();
    },
    wait(requestId) {
      return source.operationRuns?.wait(requestId) ?? Promise.resolve(unavailableRunResult());
    },
    subscribe(requestId, listener) {
      return source.operationRuns?.subscribe?.(requestId, listener) ?? (() => undefined);
    },
    cancel(requestId) {
      return source.operationRuns?.cancel(requestId) ?? unavailableRunResult<never>();
    },
    retry(requestId, retryRequestId, actor) {
      return source.operationRuns?.retry(requestId, retryRequestId, actor) ?? unavailableRunAccept();
    },
  };
  const acceptRun = (operationId: string, input: unknown, request: GatewayRunRequest): GatewayRunResult => {
    const descriptor = descriptors.get(operationId);
    if (descriptor === undefined) {
      return { ok: false, error: { code: 'not-supported', hint: `operation "${operationId}" is not registered.`, retryable: false, recoveryActions: ['editor.discover'] } };
    }
    if (!descriptor.availability.available) {
      return { ok: false, error: {
        code: 'executor-unavailable',
        hint: descriptor.availability.reason,
        retryable: true,
        recoveryActions: ['editor.discover'],
      } };
    }
    if (source.dispatch === undefined) {
      return { ok: false, error: { code: 'executor-unavailable', hint: `gateway executor for "${operationId}" is not connected.`, retryable: false, recoveryActions: ['editor.discover'] } };
    }
    const scope = request.scope;
    const journal = journalFor(scope);
    const accepted = journal.accept({
      ...request,
      runId: request.runId ?? `gateway-run-${++generatedRun}`,
      operationId,
      input,
      cancellable: request.cancellable ?? true,
      retryable: request.retryable ?? true,
    });
    if (!accepted.ok) return accepted;
    if (accepted.reused) return accepted;
    const running = journal.append({ type: 'running', runId: accepted.runId, at: Date.now() });
    if (!running.ok) return { ok: false, error: running.error };
    return { ...accepted, run: running.value };
  };
  const dispatchRun = (operationId: string, input: unknown, request: GatewayRunRequest): GatewayRunResult => {
    const inputRecord = input !== null && typeof input === 'object' ? input as Record<string, unknown> : undefined;
    const requestId = request.requestId ?? (typeof inputRecord?.requestId === 'string' ? inputRecord.requestId : undefined);
    if (operationId === 'saveDocToDisk' && requestId !== undefined) {
      return saveOperationRuns.dispatchSave(requestId, input, request.actor);
    }
    const accepted = acceptRun(operationId, input, request);
    if (!accepted.ok) return accepted;
    // A request/idempotency replay may resolve to an already-terminal run.
    // Replaying that intent must return the retained terminal fact; attempting
    // to append a new progress event would turn a safe replay into run-terminal.
    if (accepted.reused) return accepted;
    const journal = journalFor(request.scope);
    const progress = journal.updateProgress(accepted.runId, { fraction: 1, stage: 'complete' });
    if (!progress.ok) return { ok: false, error: progress.error };
    const inputArgs = input !== null && typeof input === 'object'
      ? input as Record<string, unknown>
      : { value: input };
    const result = source.dispatch!({ kind: operationId, ...inputArgs }, 'ai');
    if (result.ok === false) {
      const runError = (result.error as import('@forgeax/editor-product').CommandError | undefined) ?? {
        code: 'operation-failed',
        hint: 'The gateway operation failed.',
        retryable: false,
        recoveryActions: [],
      };
      journal.append({
        type: 'failed',
        runId: accepted.runId,
        at: Date.now(),
        error: runError,
      });
    } else {
      journal.append({ type: 'succeeded', runId: accepted.runId, at: Date.now(), result: result.result ?? result });
    }
    return accepted;
  };
  return {
    registry,
    capabilities: () => registry.discover({ includeUnavailable: true }),
    product: () => createEditorProduct({
      capabilityRegistry: registry,
      availability: {
        available: true,
        blocking: false,
        code: 'product-available',
      },
    }),
    dispose() {
      unsubscribeCapabilities();
      for (const id of managedIds) registry.unregister(id);
      managedIds = [];
      descriptors.clear();
    },
    saveOperationRuns,
    acceptRun,
    dispatchRun,
    getRun(runId) {
      return journalForRun(runId)?.getRun(runId);
    },
    listRunEvents(runId) {
      return journalForRun(runId)?.listEvents(runId) ?? [];
    },
    updateRunProgress(runId, progress) {
      const journal = journalForRun(runId);
      if (journal === undefined) return { ok: false, error: { code: 'run-not-found', hint: `run "${runId}" is unknown.`, retryable: false, recoveryActions: ['run.list'] } };
      return journal.updateProgress(runId, progress);
    },
    cancelRun(runId) {
      const journal = journalForRun(runId);
      if (journal === undefined) return { ok: false, error: { code: 'run-not-found', hint: `run "${runId}" is unknown.`, retryable: false, recoveryActions: ['run.list'] } };
      const run = journal.getRun(runId);
      if (run === undefined) return { ok: false, error: { code: 'run-not-found', hint: `run "${runId}" is unknown.`, retryable: false, recoveryActions: ['run.list'] } };
      if (!run.cancellable) return { ok: false, error: { code: 'run-not-cancellable', hint: 'The operation cannot be cancelled.', retryable: false, recoveryActions: [] } };
      return journal.append({ type: 'cancelled', runId, at: Date.now() });
    },
    failRun(runId, runError) {
      const journal = journalForRun(runId);
      if (journal === undefined) return { ok: false, error: { code: 'run-not-found', hint: `run "${runId}" is unknown.`, retryable: false, recoveryActions: ['run.list'] } };
      return journal.append({ type: 'failed', runId, at: Date.now(), error: runError });
    },
    retryRun(runId, retryRunId) {
      const journal = journalForRun(runId);
      const run = journal?.getRun(runId);
      if (journal === undefined || run === undefined) return { ok: false, error: { code: 'run-not-found', hint: `run "${runId}" is unknown.`, retryable: false, recoveryActions: ['run.list'] } };
      if (run.status !== 'failed' || !run.retryable) return { ok: false, error: { code: 'run-not-retryable', hint: 'The failed run cannot be retried.', retryable: false, recoveryActions: [] } };
      return journal.accept({
        runId: retryRunId,
        operationId: run.operationId,
        actor: run.actor,
        sessionId: run.sessionId,
        scope: run.scope,
        ...(run.input === undefined ? {} : { input: run.input }),
        parentRunId: run.runId,
        traceId: run.traceId,
        attempt: run.attempt + 1,
        cancellable: run.cancellable,
        retryable: run.retryable,
      });
    },
    getOperationRunResult(requestId) {
      return saveOperationRuns.get(requestId);
    },
    waitOperationRun(requestId) {
      return saveOperationRuns.wait(requestId);
    },
    subscribeOperationRun(requestId, listener) {
      return saveOperationRuns.subscribe?.(requestId, listener) ?? (() => undefined);
    },
    cancelOperationRun(requestId) {
      return saveOperationRuns.cancel(requestId);
    },
    retryOperationRun(requestId, retryRequestId, actor = { id: 'ai', kind: 'ai' }) {
      return saveOperationRuns.retry(requestId, retryRequestId, actor);
    },
  };
}
