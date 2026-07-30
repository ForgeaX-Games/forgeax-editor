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
  type OperationRunRequest,
  type RunJournalAcceptResult,
  type RunJournalEventInput,
} from '@forgeax/editor-product';
import { RunJournal } from '@forgeax/editor-product';
import type { ArgsSchema, OpDescriptor } from '../io/catalog';
import type { CommandOrigin } from '../io/gateway-history';
import type { EditorOp } from '../types';

export interface GatewayDispatchResult {
  readonly ok: boolean;
  readonly [key: string]: unknown;
}

export interface GatewayCapabilitySource {
  readonly listOps: () => readonly OpDescriptor[];
  readonly dispatch?: (command: EditorOp, origin?: CommandOrigin) => GatewayDispatchResult;
}

export type GatewayRunRequest = Omit<OperationRunRequest, 'operationId' | 'input' | 'runId'> & {
  readonly runId?: string;
};

export type GatewayRunResult = RunJournalAcceptResult;

export interface GatewayCapabilityAdapter {
  readonly registry: CapabilityRegistry;
  capabilities(): readonly CapabilityDescriptor[];
  registerInto(registry: CapabilityRegistry): void;
  product(): EditorProduct;
  acceptRun(operationId: string, input: unknown, request: GatewayRunRequest): GatewayRunResult;
  dispatchRun(operationId: string, input: unknown, request: GatewayRunRequest): GatewayRunResult;
  getRun(runId: string): OperationRun | undefined;
  listRunEvents(runId: string): readonly RunJournalEventInput[];
  updateRunProgress(runId: string, progress: { readonly fraction: number; readonly stage: string }): GatewayRunMutationResult;
  cancelRun(runId: string): GatewayRunMutationResult;
  failRun(runId: string, error: import('@forgeax/editor-product').CommandError): GatewayRunMutationResult;
  retryRun(runId: string, retryRunId: string): GatewayRunResult;
}

export type GatewayRunMutationResult =
  | { readonly ok: true; readonly value: OperationRun }
  | { readonly ok: false; readonly error: import('@forgeax/editor-product').CommandError };

function argsSchemaToCapabilitySchema(schema: ArgsSchema | null): Record<string, unknown> | null {
  return schema === null ? null : { ...schema };
}

function gatewayAvailability(
  descriptor: OpDescriptor,
  hasExecutor: boolean,
): CapabilityRegistration['availability'] {
  if (hasExecutor) return { available: true };
  return {
    available: false,
    code: 'executor-unavailable',
    reason: `gateway executor for "${descriptor.id}" is not connected`,
    resolution: 'Provide an EditGateway dispatch adapter.',
  };
}

function executeGatewayCommand(
  source: GatewayCapabilitySource,
  descriptor: OpDescriptor,
  input: unknown,
): GatewayDispatchResult {
  const args = input !== null && typeof input === 'object'
    ? input as Record<string, unknown>
    : { value: input };
  return source.dispatch!({ kind: descriptor.id, ...args }, 'ai');
}

function registrationFor(
  descriptor: OpDescriptor,
  source: GatewayCapabilitySource,
): CapabilityRegistration {
  const id = `editor.${descriptor.id}`;
  const hasExecutor = source.dispatch !== undefined;
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
): void {
  for (const descriptor of source.listOps()) {
    registry.register(registrationFor(descriptor, source));
  }
}

export function createGatewayCapabilityAdapter(
  source: GatewayCapabilitySource,
): GatewayCapabilityAdapter {
  const registry = new CapabilityRegistry();
  populateRegistry(source, registry);
  const descriptors = new Map(source.listOps().map((descriptor) => [descriptor.id, descriptor]));
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
  const acceptRun = (operationId: string, input: unknown, request: GatewayRunRequest): GatewayRunResult => {
    if (descriptors.get(operationId) === undefined) {
      return { ok: false, error: { code: 'not-supported', hint: `operation "${operationId}" is not registered.`, retryable: false, recoveryActions: ['editor.discover'] } };
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
    const accepted = acceptRun(operationId, input, request);
    if (!accepted.ok) return accepted;
    const journal = journalFor(request.scope);
    const progress = journal.updateProgress(accepted.runId, { fraction: 1, stage: 'complete' });
    if (!progress.ok) return { ok: false, error: progress.error };
    const descriptor = descriptors.get(operationId)!;
    const result = executeGatewayCommand(source, descriptor, input);
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
    registerInto(target) {
      populateRegistry(source, target);
    },
    product: () => createEditorProduct({
      capabilityRegistry: registry,
      availability: {
        available: true,
        blocking: false,
        code: 'product-available',
      },
    }),
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
  };
}

export function createEditorProductFromGateway(
  source: GatewayCapabilitySource,
): EditorProduct {
  return createGatewayCapabilityAdapter(source).product();
}
