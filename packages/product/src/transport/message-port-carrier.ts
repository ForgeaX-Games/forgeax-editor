import type { CommandError, ErrorCause } from '../contracts/error';
import type { TransportRequest, TransportResponse } from '../contracts/transport';
import {
  TransportRequestSchema,
  TransportResponseSchema,
  createProtocolError,
} from './protocol';
import { createTransportService, type TransportService } from './service';

export interface TransportMessageEvent {
  readonly data: unknown;
}

/**
 * The structured subset shared by browser MessagePort and test doubles.
 * Connection handshakes stay carrier-owned; this adapter starts after a port
 * has been transferred to the peer.
 */
export interface TransportMessagePort {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: TransportMessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: TransportMessageEvent) => void): void;
  start?(): void;
  close?(): void;
}

export type MessagePortTransportErrorCode =
  | 'transport-port-disposed'
  | 'transport-port-timeout'
  | 'transport-port-duplicate-request'
  | 'transport-port-invalid-request'
  | 'transport-port-invalid-response'
  | 'transport-port-correlation-mismatch';

export class MessagePortTransportError extends Error implements CommandError {
  override readonly cause: ErrorCause | undefined = undefined;
  readonly retryable: boolean;
  readonly recoveryActions: readonly string[];

  constructor(
    readonly code: MessagePortTransportErrorCode,
    readonly hint: string,
    options: { readonly retryable?: boolean; readonly recoveryActions?: readonly string[] } = {},
  ) {
    super(`${code}: ${hint}`);
    this.name = 'MessagePortTransportError';
    this.retryable = options.retryable ?? false;
    this.recoveryActions = options.recoveryActions ?? ['transport.describe'];
  }
}

export interface MessagePortCarrierReject {
  readonly error: CommandError;
  readonly received: unknown;
}

export interface MessagePortCarrierOptions {
  readonly onReject?: (reject: MessagePortCarrierReject) => void;
}

export interface MessagePortCarrier {
  readonly service: TransportService;
  dispose(): void;
}

/** Serve the canonical product transport over an already-authenticated port. */
export function createMessagePortCarrier(
  port: TransportMessagePort,
  service = createTransportService(),
  options: MessagePortCarrierOptions = {},
): MessagePortCarrier {
  let disposed = false;
  const onMessage = (event: TransportMessageEvent): void => {
    const parsed = TransportRequestSchema.safeParse(event.data);
    if (!parsed.success) {
      options.onReject?.({
        error: createProtocolError('invalid-message', 'MessagePort carrier accepts transport requests only.'),
        received: event.data,
      });
      return;
    }
    void service.handle(parsed.data).then((response) => {
      if (!disposed) port.postMessage(response);
    });
  };

  port.addEventListener('message', onMessage);
  port.start?.();

  return {
    service,
    dispose() {
      if (disposed) return;
      disposed = true;
      port.removeEventListener('message', onMessage);
      port.close?.();
    },
  };
}

interface PendingRequest {
  readonly correlationId: string;
  readonly resolve: (response: TransportResponse) => void;
  readonly reject: (error: MessagePortTransportError) => void;
  readonly timeout: ReturnType<typeof setTimeout> | undefined;
}

export interface MessagePortTransportClientOptions {
  readonly defaultTimeoutMs?: number;
  readonly onReject?: (reject: MessagePortCarrierReject) => void;
}

export interface MessagePortTransportClient {
  request(request: TransportRequest): Promise<TransportResponse>;
  dispose(): void;
}

/**
 * Correlate canonical transport requests over a MessagePort. Runtime lease and
 * generation fencing remain outside this byte carrier and can dispose it when
 * the active ViewportRuntime changes.
 */
export function createMessagePortTransportClient(
  port: TransportMessagePort,
  options: MessagePortTransportClientOptions = {},
): MessagePortTransportClient {
  const pending = new Map<string, PendingRequest>();
  let disposed = false;

  const fail = (code: MessagePortTransportErrorCode, hint: string, retryable = false) => (
    new MessagePortTransportError(code, hint, {
      retryable,
      recoveryActions: retryable ? ['transport.reconnect', 'transport.describe'] : ['transport.describe'],
    })
  );

  const onMessage = (event: TransportMessageEvent): void => {
    const parsed = TransportResponseSchema.safeParse(event.data);
    if (!parsed.success) {
      options.onReject?.({
        error: fail('transport-port-invalid-response', 'MessagePort client received a value outside the typed response schema.'),
        received: event.data,
      });
      return;
    }

    const response = parsed.data;
    const entry = pending.get(response.id);
    if (!entry) {
      options.onReject?.({
        error: fail('transport-port-invalid-response', `No pending request owns response id ${response.id}.`),
        received: response,
      });
      return;
    }
    if (response.correlationId !== entry.correlationId) {
      pending.delete(response.id);
      if (entry.timeout !== undefined) clearTimeout(entry.timeout);
      entry.reject(fail(
        'transport-port-correlation-mismatch',
        `Response ${response.id} did not match the request correlation id.`,
      ));
      return;
    }

    pending.delete(response.id);
    if (entry.timeout !== undefined) clearTimeout(entry.timeout);
    entry.resolve(response);
  };

  port.addEventListener('message', onMessage);
  port.start?.();

  return {
    request(request) {
      if (disposed) return Promise.reject(fail('transport-port-disposed', 'The MessagePort client is already disposed.', true));
      if (!TransportRequestSchema.safeParse(request).success) {
        return Promise.reject(fail('transport-port-invalid-request', 'Request does not match editor-transport/v1.'));
      }
      if (pending.has(request.id)) {
        return Promise.reject(fail('transport-port-duplicate-request', `Request id ${request.id} is already pending.`));
      }

      return new Promise<TransportResponse>((resolve, reject) => {
        const timeoutMs = request.timeoutMs ?? options.defaultTimeoutMs;
        const timeout = timeoutMs === undefined ? undefined : setTimeout(() => {
          pending.delete(request.id);
          reject(fail('transport-port-timeout', `Request ${request.id} exceeded ${timeoutMs}ms.`, true));
        }, timeoutMs);
        pending.set(request.id, { correlationId: request.correlationId, resolve, reject, timeout });
        port.postMessage(request);
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      port.removeEventListener('message', onMessage);
      port.close?.();
      const error = fail('transport-port-disposed', 'The MessagePort client disconnected before the request completed.', true);
      for (const entry of pending.values()) {
        if (entry.timeout !== undefined) clearTimeout(entry.timeout);
        entry.reject(error);
      }
      pending.clear();
    },
  };
}
