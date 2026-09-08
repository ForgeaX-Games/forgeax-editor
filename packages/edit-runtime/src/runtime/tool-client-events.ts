import {
  createOperationRun,
  reduceOperationRun,
  type CommandError,
  type OperationRun,
  type OperationRunEvent,
  type RunActor,
  type RunProgress,
} from '@forgeax/editor-product';

export type ToolClientRunEvent =
  | {
    readonly type: 'accepted';
    readonly runId: string;
    readonly requestId?: string;
    readonly operationId: string;
    readonly actor: RunActor;
    readonly sessionId: string;
    readonly scope: string;
    readonly input?: unknown;
    readonly parentRunId?: string;
    readonly traceId: string;
    readonly sequence: number;
    readonly at: number;
    readonly attempt?: number;
    readonly cancellable?: boolean;
    readonly retryable?: boolean;
  }
  | { readonly type: 'running'; readonly runId: string; readonly sequence: number; readonly at: number }
  | { readonly type: 'progress'; readonly runId: string; readonly sequence: number; readonly at: number; readonly progress: RunProgress }
  | { readonly type: 'succeeded'; readonly runId: string; readonly sequence: number; readonly at: number; readonly result?: unknown }
  | { readonly type: 'failed'; readonly runId: string; readonly sequence: number; readonly at: number; readonly error: CommandError }
  | { readonly type: 'cancelled'; readonly runId: string; readonly sequence: number; readonly at: number; readonly error?: CommandError };

export interface ToolClientProjectionSnapshot {
  readonly revision: number;
  readonly runs: readonly OperationRun[];
}

export interface ToolClientProjection {
  readonly authority: 'host-toolclient-observer';
  getSnapshot(): ToolClientProjectionSnapshot;
  subscribe(listener: () => void): () => void;
  reconnect(): ToolClientProjectionSnapshot;
  disconnect(): void;
}

type MutableProjection = ToolClientProjection & {
  readonly _runs: Map<string, OperationRun>;
  _revision: number;
  _disconnected: boolean;
  readonly _listeners: Set<() => void>;
};

export function createToolClientProjection(): ToolClientProjection {
  const listeners = new Set<() => void>();
  const runs = new Map<string, OperationRun>();
  const projection: MutableProjection = {
    authority: 'host-toolclient-observer',
    _runs: runs,
    _revision: 0,
    _disconnected: false,
    _listeners: listeners,
    getSnapshot() {
      return Object.freeze({ revision: this._revision, runs: Object.freeze([...this._runs.values()]) });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reconnect() {
      this._disconnected = false;
      return this.getSnapshot();
    },
    disconnect() {
      this._disconnected = true;
    },
  };
  return projection;
}

function toProductEvent(event: ToolClientRunEvent): OperationRunEvent {
  if (event.type === 'accepted') {
    return {
      type: 'accepted', runId: event.runId, sequence: event.sequence, at: event.at,
      ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
      operationId: event.operationId, actor: event.actor, sessionId: event.sessionId,
      scope: event.scope, ...(event.input === undefined ? {} : { input: event.input }),
      ...(event.parentRunId === undefined ? {} : { parentRunId: event.parentRunId }),
      traceId: event.traceId, attempt: event.attempt ?? 1,
      cancellable: event.cancellable ?? false, retryable: event.retryable ?? false,
    };
  }
  return event;
}

export function applyToolClientRunEvent(
  source: ToolClientProjection,
  event: ToolClientRunEvent,
): { readonly ok: true; readonly value: OperationRun } | { readonly ok: false; readonly error: CommandError } {
  const mutable = source as MutableProjection;
  if (mutable._disconnected) {
    return { ok: false, error: { code: 'tool-client-disconnected', hint: 'The host ToolClient observer is disconnected.', retryable: true, recoveryActions: ['operations.reconnect'] } };
  }
  let next: OperationRun | undefined;
  if (event.type === 'accepted') {
    const created = createOperationRun({
      runId: event.runId, requestId: event.requestId, operationId: event.operationId,
      actor: event.actor, sessionId: event.sessionId, scope: event.scope, input: event.input,
      parentRunId: event.parentRunId, traceId: event.traceId, attempt: event.attempt,
      cancellable: event.cancellable, retryable: event.retryable,
    }, event.at);
    if (!created.ok) return created;
    next = created.value;
  } else {
    const current = mutable._runs.get(event.runId);
    if (current === undefined) {
      return { ok: false, error: { code: 'tool-client-run-missing', hint: `No accepted ToolClient run exists for ${event.runId}.`, retryable: false, recoveryActions: [] } };
    }
    const reduced = reduceOperationRun(current, toProductEvent(event));
    if (!reduced.ok) return reduced;
    next = reduced.value;
  }
  mutable._runs.set(next.runId, next);
  mutable._revision += 1;
  for (const listener of [...mutable._listeners]) listener();
  return { ok: true, value: next };
}
