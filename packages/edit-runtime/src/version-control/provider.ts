import {
  EditGateway,
  acquireGatewayWrite,
  registerSessionApplier,
  VERSION_CONTROL_OPERATION_IDS,
  versionControlOperationDescriptors,
  type GatewayWriteBarrier,
  type VersionControlOperationId,
  type VersionControlSnapshot,
} from '@forgeax/editor-core';
import { createVersionControlSnapshotEnvelope } from '@forgeax/editor-core';
import {
  applySwitchWithGatewayBarrier,
  type SwitchCheckoutFailure,
  type SwitchCheckoutSuccess,
  type SwitchPreflightInput,
} from './switch-applier';
import type { RuntimeGenerationHandoff, RuntimeSuccessor } from './generation-handoff';
import { createVersionControlRecoveryController, type VersionControlRecoveryController } from './recovery';

export interface VersionControlHostPort {
  /** Host-selected game root; never serialized into a browser command payload. */
  readonly gameRoot: string;
  readonly readSnapshot: () => VersionControlSnapshot | Promise<VersionControlSnapshot>;
  readonly runCommand: (operation: VersionControlOperationId, input: unknown) => unknown | Promise<unknown>;
}

export interface VersionControlProvider {
  readonly generation: number;
  readonly snapshot: () => VersionControlSnapshot;
  readonly refresh: () => Promise<VersionControlSnapshot>;
  readonly dispatch: (operation: VersionControlOperationId, input: unknown) => Promise<unknown>;
  readonly clear: () => void;
  readonly subscribe: (listener: () => void) => () => void;
}

export interface VersionControlHostPortOptions {
  readonly gameRoot: string;
  readonly generation: number;
  readonly fetch?: VersionControlFetch;
  readonly basePath?: string;
}

export type VersionControlFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface VersionControlRuntimeTransition {
  readonly barrier: GatewayWriteBarrier;
  readonly handoff: RuntimeGenerationHandoff;
  readonly readPreflight: () => SwitchPreflightInput | Promise<SwitchPreflightInput>;
  readonly teardown: () => void | Promise<void>;
  readonly bootSuccessor: (generation: number) => RuntimeSuccessor | Promise<RuntimeSuccessor>;
  readonly terminal: (status: 'succeeded' | 'failed', result: unknown) => void;
  /** Called after the provider has refreshed its projection for a completed command. */
  readonly committed?: (result: unknown) => void;
  readonly disposeOld?: () => void | Promise<void>;
  readonly freeze?: (reason: string) => void;
}

export interface VersionControlRuntimeBinding {
  readonly provider: VersionControlProvider;
  readonly recovery: VersionControlRecoveryController;
  readonly dispose: () => void;
}

export interface VersionControlFreshReader {
  readonly realmId: string;
  readonly readSnapshot: () => Promise<VersionControlSnapshot>;
}

export type VersionControlDurabilityState = 'dirty' | 'clean' | 'unknown';

export interface VersionControlDurabilityResult {
  readonly requestId: string;
  readonly writerRealmId: string;
  readonly readerRealmId: string | null;
  readonly state: VersionControlDurabilityState;
  readonly authoritative: VersionControlSnapshot | null;
  readonly observed: VersionControlSnapshot | null;
  readonly error?: {
    readonly code: 'invalid-request' | 'save-failed' | 'reader-not-independent' | 'read-back-failed' | 'durability-mismatch';
    readonly hint: string;
    readonly retryable: boolean;
    readonly recoveryActions: readonly string[];
  };
}

function stableSnapshot(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSnapshot);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableSnapshot(entry)]));
  }
  return value;
}

function snapshotsEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableSnapshot(left)) === JSON.stringify(stableSnapshot(right));
}

export async function verifyDurableVersionControlSave(input: {
  readonly requestId: string;
  readonly writerRealmId: string;
  readonly authoritative: VersionControlSnapshot;
  readonly createFreshReader: () => Promise<VersionControlFreshReader>;
}): Promise<VersionControlDurabilityResult> {
  const base = {
    requestId: input.requestId,
    writerRealmId: input.writerRealmId,
    authoritative: input.authoritative,
  };
  if (!input.requestId.trim() || !input.writerRealmId.trim()) return {
    ...base,
    state: 'unknown',
    readerRealmId: null,
    observed: null,
    error: { code: 'invalid-request', hint: 'A durable Save requires a requestId and writer realm.', retryable: false, recoveryActions: ['version-control.refresh', 'run.retry'] },
  };
  let reader: VersionControlFreshReader;
  try { reader = await input.createFreshReader(); } catch {
    return {
      ...base,
      state: 'unknown',
      readerRealmId: null,
      observed: null,
      error: { code: 'read-back-failed', hint: 'The independent reader could not be created; durability is unknown.', retryable: true, recoveryActions: ['version-control.refresh', 'run.retry'] },
    };
  }
  if (!reader.realmId.trim() || reader.realmId === input.writerRealmId) return {
    ...base,
    state: 'unknown',
    readerRealmId: reader.realmId || null,
    observed: null,
    error: { code: 'reader-not-independent', hint: 'The read-back realm must be newly created and distinct from the writer.', retryable: false, recoveryActions: ['version-control.refresh', 'run.retry'] },
  };
  let observed: VersionControlSnapshot;
  try { observed = await reader.readSnapshot(); } catch {
    return {
      ...base,
      state: 'unknown',
      readerRealmId: reader.realmId,
      observed: null,
      error: { code: 'read-back-failed', hint: 'The fresh reader failed; durability is unknown.', retryable: true, recoveryActions: ['version-control.refresh', 'run.retry'] },
    };
  }
  if (!snapshotsEqual(input.authoritative, observed)) return {
    ...base,
    state: 'dirty',
    readerRealmId: reader.realmId,
    observed,
    error: { code: 'durability-mismatch', hint: 'Fresh read-back differs from the authoritative Save result.', retryable: true, recoveryActions: ['version-control.refresh', 'run.retry'] },
  };
  return { ...base, state: 'clean', readerRealmId: reader.realmId, observed };
}

export async function saveAndVerifyDurableVersionControl(input: {
  readonly requestId: string;
  readonly writerRealmId: string;
  readonly save: () => Promise<VersionControlSnapshot>;
  readonly createFreshReader: () => Promise<VersionControlFreshReader>;
}): Promise<VersionControlDurabilityResult> {
  if (!input.requestId.trim() || !input.writerRealmId.trim()) return {
    requestId: input.requestId,
    writerRealmId: input.writerRealmId,
    state: 'unknown',
    readerRealmId: null,
    authoritative: null,
    observed: null,
    error: { code: 'invalid-request', hint: 'Save requires a requestId and writer realm.', retryable: false, recoveryActions: ['version-control.refresh', 'run.retry'] },
  };
  let authoritative: VersionControlSnapshot;
  try { authoritative = await input.save(); } catch {
    return {
      requestId: input.requestId,
      writerRealmId: input.writerRealmId,
      state: 'unknown',
      readerRealmId: null,
      authoritative: null,
      observed: null,
      error: { code: 'save-failed', hint: 'The authoritative Host save failed; durability is unknown.', retryable: true, recoveryActions: ['version-control.refresh', 'run.retry'] },
    };
  }
  return verifyDurableVersionControlSave({ ...input, authoritative });
}

function checkoutResult(value: unknown): SwitchCheckoutSuccess | SwitchCheckoutFailure {
  if (value !== null && typeof value === 'object') {
    const candidate = value as Record<string, unknown>;
    if (candidate.ok === true && candidate.receipt !== null && typeof candidate.receipt === 'object') {
      return { ok: true, receipt: candidate.receipt as SwitchCheckoutSuccess['receipt'] };
    }
    // The canonical Host router wraps successful commands in `{ ok: true,
    // value: ... }`. Keep accepting the direct receipt shape used by injected
    // test Hosts, but always unwrap the wire envelope before handing the
    // generation handoff its checkout receipt.
    if (candidate.ok === true && candidate.value !== null && typeof candidate.value === 'object') {
      const wrapped = candidate.value as Record<string, unknown>;
      if (wrapped.receipt !== null && typeof wrapped.receipt === 'object') {
        return { ok: true, receipt: wrapped.receipt as SwitchCheckoutSuccess['receipt'] };
      }
      if (typeof wrapped.targetCommit === 'string' && typeof wrapped.repositoryIdentity === 'string') {
        return { ok: true, receipt: wrapped as unknown as SwitchCheckoutSuccess['receipt'] };
      }
    }
    if (candidate.ok === false && candidate.error !== null && typeof candidate.error === 'object') {
      return { ok: false, error: candidate.error as SwitchCheckoutFailure['error'] };
    }
    if (typeof candidate.targetCommit === 'string' && typeof candidate.repositoryIdentity === 'string') {
      return { ok: true, receipt: candidate as unknown as SwitchCheckoutSuccess['receipt'] };
    }
  }
  return {
    ok: false,
    error: {
      code: 'version-control-command-failed',
      hint: 'The Host did not return a valid switch receipt.',
      recoveryActions: ['version-control.refresh', 'run.retry'],
    },
  };
}

/**
 * Bind one live Runtime generation to the canonical provider, catalog and
 * Gateway appliers. The optional transition is the carrier-owned seam; when
 * present, switch uses the existing barrier/handoff/recovery owner rather than
 * falling back to a second command path.
 */
export function createVersionControlRuntimeBinding(options: {
  readonly gateway: EditGateway;
  readonly generation: number;
  readonly host: VersionControlHostPort;
  readonly transition?: VersionControlRuntimeTransition;
}): VersionControlRuntimeBinding {
  const recovery = createVersionControlRecoveryController(options.generation);
  const transition = options.transition;
  const provider = createVersionControlProvider({
    generation: options.generation,
    host: options.host,
    ...(transition === undefined ? {} : {
      dispatchOperation: (operation, input) => {
        if (operation !== 'switchGameVersion') return options.host.runCommand(operation, input);
        return applySwitchWithGatewayBarrier(transition.barrier, {
          readPreflight: transition.readPreflight,
          checkout: async (checkoutInput) => checkoutResult(await options.host.runCommand(operation, checkoutInput)),
          handoff: transition.handoff,
          teardown: transition.teardown,
          bootSuccessor: transition.bootSuccessor,
          terminal: transition.terminal,
          disposeOld: transition.disposeOld,
          freeze: (reason) => {
            recovery.freeze({ generation: options.generation, error: reason });
            transition.freeze?.(reason);
          },
        }, input);
      },
      onCommitted: transition === undefined
        ? undefined
        : (operation, result) => {
          if (operation === 'switchGameVersion') transition.committed?.(result);
        },
    }),
  });
  const disposeAppliers = createVersionControlProviderAppliers({ gateway: options.gateway, provider });
  const unsubscribeRuns = options.gateway.subscribeOperationRuns((run) => {
    if (run.operationId === undefined || !(VERSION_CONTROL_OPERATION_IDS as readonly string[]).includes(run.operationId)) return;
    void provider.refresh().catch(() => undefined);
  });
  void provider.refresh().catch(() => undefined);
  return {
    provider,
    recovery,
    dispose: () => {
      unsubscribeRuns();
      provider.clear();
      disposeAppliers();
    },
  };
}

function commandErrorFromResponse(payload: unknown, status: number): Error {
  if (payload !== null && typeof payload === 'object') {
    const value = payload as { readonly error?: unknown; readonly code?: unknown; readonly hint?: unknown };
    const candidate = value.error !== undefined ? value.error : value;
    if (candidate !== null && typeof candidate === 'object') {
      const error = candidate as {
        readonly code?: unknown;
        readonly hint?: unknown;
        readonly stage?: unknown;
        readonly expected?: unknown;
        readonly actual?: unknown;
        readonly requestId?: unknown;
        readonly commitIdentity?: unknown;
        readonly recoveryActions?: unknown;
        readonly cause?: unknown;
        readonly retryable?: unknown;
      };
      if (typeof error.code === 'string' && typeof error.hint === 'string') {
        return Object.assign(new Error(error.hint), {
          code: error.code,
          hint: error.hint,
          status,
          ...(typeof error.stage === 'string' ? { stage: error.stage } : {}),
          ...(error.expected === undefined ? {} : { expected: error.expected }),
          ...(error.actual === undefined ? {} : { actual: error.actual }),
          ...(typeof error.requestId === 'string' ? { requestId: error.requestId } : {}),
          ...(typeof error.commitIdentity === 'string' ? { commitIdentity: error.commitIdentity } : {}),
          ...(Array.isArray(error.recoveryActions) ? { recoveryActions: error.recoveryActions.filter((item): item is string => typeof item === 'string') } : {}),
          ...(error.cause === undefined ? {} : { cause: error.cause }),
          ...(typeof error.retryable === 'boolean' ? { retryable: error.retryable } : {}),
        });
      }
    }
  }
  return Object.assign(new Error(`Version-control Host request failed: HTTP ${status}`), {
    code: 'version-control-command-failed',
    hint: `The active Host rejected the version-control request (HTTP ${status}).`,
    status,
    retryable: true,
    recoveryActions: ['version-control.refresh', 'run.retry'],
  });
}

/**
 * Build the browser-side HostPort. The server route is already scoped to the
 * host-selected game; `gameRoot` is retained as an authority fact for the
 * Runtime binding and is deliberately never copied into request JSON.
 */
export function createVersionControlHostPort(options: VersionControlHostPortOptions): VersionControlHostPort {
  const fetchImpl: VersionControlFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const basePath = options.basePath ?? '/api/version-control';
  const request = async (path: string, init?: RequestInit): Promise<unknown> => {
    const response = await fetchImpl(`${basePath}${path}`, {
      ...init,
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
    let payload: unknown;
    try { payload = await response.json(); } catch { payload = undefined; }
    if (!response.ok) throw commandErrorFromResponse(payload, response.status);
    return payload;
  };
  const readSnapshot = async (): Promise<unknown> => {
    const response = await fetchImpl(`${basePath}/snapshot`, {
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
    });
    let payload: unknown;
    try { payload = await response.json(); } catch { payload = undefined; }
    // An uninitialized or recovery-required repository is a valid snapshot
    // projection, even though the scoped Host uses 503 to make the state
    // visible to non-Runtime callers. Preserve that discriminated value so
    // the Settings/Initialize flow can operate through the same provider.
    if (!response.ok && !(payload !== null && typeof payload === 'object' && typeof (payload as { readonly status?: unknown }).status === 'string')) {
      throw commandErrorFromResponse(payload, response.status);
    }
    return payload;
  };
  return Object.freeze({
    gameRoot: options.gameRoot,
    readSnapshot: async () => {
      const payload = await readSnapshot() as Record<string, unknown> | undefined;
      if (payload === undefined || typeof payload !== 'object') {
        return {
          generation: options.generation,
          status: 'faulted' as const,
          error: { code: 'version-control-unexpected' as const, hint: 'The Host returned an invalid version-control snapshot.' },
        } as VersionControlSnapshot;
      }
      return { ...payload, generation: options.generation } as VersionControlSnapshot;
    },
    runCommand: (operation: VersionControlOperationId, input: unknown) => request(`/commands/${encodeURIComponent(operation)}`, {
      method: 'POST',
      body: JSON.stringify(input ?? {}),
    }),
  });
}

/** Provider contract consumed by Runtime; it never exposes Git argv or Node APIs. */
export function createVersionControlProvider(options: {
  readonly generation: number;
  readonly host: VersionControlHostPort;
  readonly dispatchOperation?: (operation: VersionControlOperationId, input: unknown) => unknown | Promise<unknown>;
  readonly onCommitted?: (operation: VersionControlOperationId, result: unknown) => void;
}): VersionControlProvider {
  let current: VersionControlSnapshot = {
    generation: options.generation,
    status: 'unavailable',
    error: { code: 'version-control-unavailable', hint: 'The current game Host is not connected.' },
  };
  const refresh = async (): Promise<VersionControlSnapshot> => {
    const next = await options.host.readSnapshot();
    if (next.generation !== options.generation) {
      current = {
        generation: options.generation,
        status: 'faulted',
        error: { code: 'version-control-unexpected', hint: 'The Host returned a stale Runtime generation.' },
      };
    } else {
      current = next;
    }
    publish();
    return current;
  };
  const listeners = new Set<() => void>();
  const publish = (): void => { for (const listener of [...listeners]) listener(); };
  return {
    generation: options.generation,
    snapshot: () => current,
    refresh,
    dispatch: async (operation, input) => {
      const result = await (options.dispatchOperation?.(operation, input) ?? options.host.runCommand(operation, input));
      await refresh();
      options.onCommitted?.(operation, result);
      return result;
    },
    clear: () => {
      current = {
        generation: options.generation,
        status: 'unavailable',
        error: { code: 'version-control-unavailable', hint: 'The version-control projection was cleared.' },
      };
      publish();
    },
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

export function installVersionControlCatalog(): void {
  for (const descriptor of versionControlOperationDescriptors()) {
    EditGateway.registerBuiltinOp({
      id: descriptor.id,
      domain: descriptor.domain,
      argsSchema: descriptor.argsSchema,
      title: descriptor.id,
      confirmation: descriptor.confirmation,
      operationRun: descriptor.operationRun,
      recoveryActions: descriptor.recoveryActions,
    } as never);
  }
}

export function projectVersionControlSnapshot(provider: VersionControlProvider) {
  const snapshot = provider.snapshot();
  return createVersionControlSnapshotEnvelope(snapshot);
}

export function createVersionControlProviderAppliers(options: {
  readonly gateway: EditGateway;
  readonly provider: VersionControlProvider;
}): () => void {
  installVersionControlCatalog();
  const disposers = versionControlOperationDescriptors().map((descriptor) => registerSessionApplier(
    descriptor.id,
    (op) => {
      const lease = acquireGatewayWrite(options.gateway, 'version-control');
      if (!lease.ok) return lease;
      const { kind: _kind, ...input } = op as { readonly kind?: unknown; readonly [key: string]: unknown };
      const request = input as { readonly requestId?: unknown };
      const operation = descriptor.id as VersionControlOperationId;
      const completion = options.provider.dispatch(operation, input).finally(lease.lease.release);
      if (typeof request.requestId === 'string') return { ok: true as const, completion };
      return { ok: true as const, completion };
    },
    {
      title: descriptor.id,
      argsSchema: descriptor.argsSchema,
      operationRun: descriptor.operationRun,
      confirmation: descriptor.confirmation,
      recoveryActions: descriptor.recoveryActions,
    },
  ));
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
