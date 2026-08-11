import type {
  CommandError,
  TransportMessagePort,
} from '@forgeax/editor-product';

export const PREVIEW_EXECUTOR_LEASE_VERSION = 'preview-executor-lease/v1' as const;
export const PREVIEW_EXECUTOR_REQUEST = 'FORGEAX_PREVIEW_EXECUTOR_REQUEST' as const;
export const PREVIEW_EXECUTOR_RESPONSE = 'FORGEAX_PREVIEW_EXECUTOR_RESPONSE' as const;

export interface PreviewExecutorLeaseIdentity {
  readonly version: typeof PREVIEW_EXECUTOR_LEASE_VERSION;
  readonly leaseId: string;
  readonly kind: string;
  readonly assetGuid: string;
  readonly generation: number;
}

export type PreviewExecutorResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: CommandError };

export interface ShellPreviewExecutorLease {
  readonly identity: PreviewExecutorLeaseIdentity;
  execute(command: unknown): PreviewExecutorResult | Promise<PreviewExecutorResult>;
}

export interface PreviewExecutorLeaseSnapshot {
  readonly revision: number;
  readonly lease: ShellPreviewExecutorLease | null;
  readonly connected: boolean;
}

export interface PreviewExecutorClient {
  readonly identity: PreviewExecutorLeaseIdentity;
  execute(command: unknown): Promise<PreviewExecutorResult>;
  dispose(): void;
}

interface PreviewExecutorRequestMessage {
  readonly type: typeof PREVIEW_EXECUTOR_REQUEST;
  readonly requestId: string;
  readonly lease: PreviewExecutorLeaseIdentity;
  readonly revision: number;
  readonly command: unknown;
}

interface PreviewExecutorResponseMessage {
  readonly type: typeof PREVIEW_EXECUTOR_RESPONSE;
  readonly requestId: string;
  readonly lease: PreviewExecutorLeaseIdentity;
  readonly revision: number;
  readonly result: PreviewExecutorResult;
}

interface PendingRequest {
  readonly resolve: (result: PreviewExecutorResult) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

let nextGeneration = 0;
let shellRevision = 0;
let activeShellLease: ShellPreviewExecutorLease | null = null;
let connectedLeaseId: string | null = null;
let shellSnapshot: PreviewExecutorLeaseSnapshot = Object.freeze({
  revision: 0,
  lease: null,
  connected: false,
});
const shellListeners = new Set<() => void>();

function error(
  code: string,
  hint: string,
  retryable = true,
  recoveryActions: readonly string[] = ['editor.discover'],
): CommandError {
  return {
    code,
    owner: 'host',
    category: 'transport',
    hint,
    retryable,
    recoveryActions,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isPreviewExecutorLeaseIdentity(value: unknown): value is PreviewExecutorLeaseIdentity {
  return isRecord(value)
    && value.version === PREVIEW_EXECUTOR_LEASE_VERSION
    && typeof value.leaseId === 'string'
    && value.leaseId.length > 0
    && typeof value.kind === 'string'
    && value.kind.length > 0
    && typeof value.assetGuid === 'string'
    && value.assetGuid.length > 0
    && Number.isSafeInteger(value.generation)
    && (value.generation as number) > 0;
}

export function samePreviewExecutorLease(
  expected: PreviewExecutorLeaseIdentity,
  received: PreviewExecutorLeaseIdentity,
): boolean {
  return expected.version === received.version
    && expected.leaseId === received.leaseId
    && expected.kind === received.kind
    && expected.assetGuid === received.assetGuid
    && expected.generation === received.generation;
}

function isRequestMessage(value: unknown): value is PreviewExecutorRequestMessage {
  return isRecord(value)
    && value.type === PREVIEW_EXECUTOR_REQUEST
    && typeof value.requestId === 'string'
    && isPreviewExecutorLeaseIdentity(value.lease)
    && Number.isSafeInteger(value.revision)
    && (value.revision as number) > 0
    && 'command' in value;
}

function isCommandError(value: unknown): value is CommandError {
  return isRecord(value)
    && typeof value.code === 'string'
    && typeof value.hint === 'string'
    && typeof value.retryable === 'boolean'
    && Array.isArray(value.recoveryActions)
    && value.recoveryActions.every((action) => typeof action === 'string');
}

function isResult(value: unknown): value is PreviewExecutorResult {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false;
  return value.ok === true ? 'value' in value : isCommandError(value.error);
}

function isResponseMessage(value: unknown): value is PreviewExecutorResponseMessage {
  return isRecord(value)
    && value.type === PREVIEW_EXECUTOR_RESPONSE
    && typeof value.requestId === 'string'
    && isPreviewExecutorLeaseIdentity(value.lease)
    && Number.isSafeInteger(value.revision)
    && (value.revision as number) > 0
    && isResult(value.result);
}

function publishShellLease(): void {
  shellRevision += 1;
  shellSnapshot = Object.freeze({
    revision: shellRevision,
    lease: activeShellLease,
    connected: activeShellLease !== null && connectedLeaseId === activeShellLease.identity.leaseId,
  });
  for (const listener of [...shellListeners]) listener();
}

export function createPreviewExecutorLeaseIdentity(
  kind: string,
  assetGuid: string,
  randomId: () => string = () => crypto.randomUUID(),
): PreviewExecutorLeaseIdentity {
  return Object.freeze({
    version: PREVIEW_EXECUTOR_LEASE_VERSION,
    leaseId: randomId(),
    kind,
    assetGuid,
    generation: ++nextGeneration,
  });
}

export function getShellPreviewExecutorLeaseSnapshot(): PreviewExecutorLeaseSnapshot {
  return shellSnapshot;
}

export function subscribeShellPreviewExecutorLease(listener: () => void): () => void {
  shellListeners.add(listener);
  return () => shellListeners.delete(listener);
}

/** Install one replaceable Shell executor. Disposing an older registration can
 * never revive it after a newer preview generation has taken ownership. */
export function registerShellPreviewExecutorLease(lease: ShellPreviewExecutorLease): () => void {
  activeShellLease = lease;
  connectedLeaseId = null;
  publishShellLease();
  let live = true;
  return () => {
    if (!live) return;
    live = false;
    if (activeShellLease !== lease) return;
    activeShellLease = null;
    connectedLeaseId = null;
    publishShellLease();
  };
}

/** Carrier acknowledgement only changes presentation readiness; it cannot
 * resurrect a lease that the preview owner already released. */
export function markShellPreviewExecutorLeaseConnected(
  identity: PreviewExecutorLeaseIdentity | null,
): void {
  const next = identity !== null
    && activeShellLease !== null
    && samePreviewExecutorLease(activeShellLease.identity, identity)
      ? identity.leaseId
      : null;
  if (next === connectedLeaseId) return;
  connectedLeaseId = next;
  publishShellLease();
}

/** Serve one already-authenticated reverse port. Runtime identity/origin/source
 * checks are deliberately owned by viewport-runtime-transport before this
 * byte-level carrier is created. */
export function createPreviewExecutorCarrier(
  port: TransportMessagePort,
  lease: ShellPreviewExecutorLease,
): { dispose(): void } {
  let disposed = false;
  let lastRevision = 0;
  let queue = Promise.resolve();
  const respond = (message: PreviewExecutorRequestMessage, result: PreviewExecutorResult): void => {
    if (disposed) return;
    port.postMessage({
      type: PREVIEW_EXECUTOR_RESPONSE,
      requestId: message.requestId,
      lease: lease.identity,
      revision: message.revision,
      result,
    } satisfies PreviewExecutorResponseMessage);
  };
  const onMessage = (event: { readonly data: unknown }): void => {
    if (!isRequestMessage(event.data)) return;
    const message = event.data;
    if (!samePreviewExecutorLease(lease.identity, message.lease)) {
      respond(message, { ok: false, error: error(
        'preview-executor-stale-generation',
        'The preview request targets a released asset generation.',
      ) });
      return;
    }
    if (message.revision <= lastRevision) {
      respond(message, { ok: false, error: error(
        'preview-executor-stale-revision',
        'The preview request revision is not newer than the last accepted request.',
        false,
        ['editor.discover'],
      ) });
      return;
    }
    lastRevision = message.revision;
    queue = queue.then(async () => {
      if (disposed) return;
      try {
        respond(message, await lease.execute(message.command));
      } catch (cause) {
        respond(message, { ok: false, error: error(
          'preview-executor-failed',
          cause instanceof Error ? cause.message : String(cause),
        ) });
      }
    });
  };
  port.addEventListener('message', onMessage);
  port.start?.();
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      port.removeEventListener('message', onMessage);
      port.close?.();
    },
  };
}

export function createPreviewExecutorClient(
  port: TransportMessagePort,
  identity: PreviewExecutorLeaseIdentity,
  timeoutMs = 15_000,
): PreviewExecutorClient {
  let disposed = false;
  let revision = 0;
  const pending = new Map<string, PendingRequest>();
  const disconnected = (): PreviewExecutorResult => ({ ok: false, error: error(
    'preview-executor-disconnected',
    'The Shell preview executor disconnected before the request completed.',
  ) });
  const onMessage = (event: { readonly data: unknown }): void => {
    if (!isResponseMessage(event.data) || !samePreviewExecutorLease(identity, event.data.lease)) return;
    const request = pending.get(event.data.requestId);
    if (request === undefined) return;
    pending.delete(event.data.requestId);
    clearTimeout(request.timeout);
    request.resolve(event.data.result);
  };
  port.addEventListener('message', onMessage);
  port.start?.();
  return {
    identity,
    execute(command) {
      if (disposed) return Promise.resolve(disconnected());
      const nextRevision = ++revision;
      const requestId = `${identity.leaseId}:${nextRevision}`;
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          pending.delete(requestId);
          resolve({ ok: false, error: error(
            'preview-executor-timeout',
            `Preview request ${requestId} exceeded ${timeoutMs}ms.`,
          ) });
        }, timeoutMs);
        pending.set(requestId, { resolve, timeout });
        port.postMessage({
          type: PREVIEW_EXECUTOR_REQUEST,
          requestId,
          lease: identity,
          revision: nextRevision,
          command,
        } satisfies PreviewExecutorRequestMessage);
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      port.removeEventListener('message', onMessage);
      port.close?.();
      for (const request of pending.values()) {
        clearTimeout(request.timeout);
        request.resolve(disconnected());
      }
      pending.clear();
    },
  };
}

export function createInProcessPreviewExecutorClient(
  lease: ShellPreviewExecutorLease,
): PreviewExecutorClient {
  let disposed = false;
  return {
    identity: lease.identity,
    async execute(command) {
      if (disposed) return { ok: false, error: error(
        'preview-executor-disconnected',
        'The in-process preview executor lease is no longer active.',
      ) };
      try {
        return await lease.execute(command);
      } catch (cause) {
        return { ok: false, error: error(
          'preview-executor-failed',
          cause instanceof Error ? cause.message : String(cause),
        ) };
      }
    },
    dispose() { disposed = true; },
  };
}

/** Same-realm carrier for Studio/local hosts. It preserves the identical
 * replaceable lease and Runtime-owned binding lifecycle without serializing a
 * MessagePort hop that has no realm boundary to cross. */
export function installInProcessPreviewExecutorLeaseHost(
  bind: (identity: PreviewExecutorLeaseIdentity, client: PreviewExecutorClient) => () => void,
): () => void {
  let active: {
    readonly lease: ShellPreviewExecutorLease;
    readonly client: PreviewExecutorClient;
    readonly disposeBinding: () => void;
  } | null = null;
  const disconnect = (publish = true): void => {
    const current = active;
    active = null;
    if (current === null) return;
    current.disposeBinding();
    current.client.dispose();
    if (publish) markShellPreviewExecutorLeaseConnected(null);
  };
  const sync = (): void => {
    const lease = getShellPreviewExecutorLeaseSnapshot().lease;
    if (active !== null && lease === active.lease) return;
    disconnect(false);
    if (lease === null) {
      markShellPreviewExecutorLeaseConnected(null);
      return;
    }
    const client = createInProcessPreviewExecutorClient(lease);
    const disposeBinding = bind(lease.identity, client);
    active = { lease, client, disposeBinding };
    markShellPreviewExecutorLeaseConnected(lease.identity);
  };
  const unsubscribe = subscribeShellPreviewExecutorLease(sync);
  sync();
  return () => {
    unsubscribe();
    disconnect();
  };
}
