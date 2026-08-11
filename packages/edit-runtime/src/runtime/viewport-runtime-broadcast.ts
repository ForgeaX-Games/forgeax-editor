import {
  isCurrentViewportRuntime,
  type MessagePortTransportClient,
  type TransportRequest,
  type TransportResponse,
  type TransportService,
  type ViewportRuntimeIdentity,
} from '@forgeax/editor-product';

export type { MessagePortTransportClient, ViewportRuntimeIdentity } from '@forgeax/editor-product';

export const VIEWPORT_RUNTIME_BROADCAST_CHANNEL = 'forgeax.viewport-runtime/v1' as const;
const BROADCAST_PROTOCOL = 'forgeax.viewport-runtime-broadcast/v1' as const;

interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  close(): void;
}

type ChannelFactory = (name: string) => BroadcastChannelLike;

type ReadyMessage = {
  readonly protocol: typeof BROADCAST_PROTOCOL;
  readonly kind: 'ready';
  readonly runtime: ViewportRuntimeIdentity;
};

type RequestMessage = {
  readonly protocol: typeof BROADCAST_PROTOCOL;
  readonly kind: 'request';
  readonly runtime: ViewportRuntimeIdentity;
  readonly request: TransportRequest;
};

type ResponseMessage = {
  readonly protocol: typeof BROADCAST_PROTOCOL;
  readonly kind: 'response';
  readonly runtime: ViewportRuntimeIdentity;
  readonly requestId: string;
  readonly response: TransportResponse;
};

export type ViewportRuntimeBroadcastMessage = ReadyMessage | RequestMessage | ResponseMessage;

function defaultFactory(name: string): BroadcastChannelLike {
  return new BroadcastChannel(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameRuntime(left: ViewportRuntimeIdentity, right: ViewportRuntimeIdentity): boolean {
  return isCurrentViewportRuntime(left, right)
    && left.carrierId === right.carrierId
    && left.carrierKind === right.carrierKind;
}

function isReadyMessage(value: unknown): value is ReadyMessage {
  return isRecord(value)
    && value.protocol === BROADCAST_PROTOCOL
    && value.kind === 'ready'
    && isRecord(value.runtime);
}

function isRequestMessage(value: unknown): value is RequestMessage {
  return isRecord(value)
    && value.protocol === BROADCAST_PROTOCOL
    && value.kind === 'request'
    && isRecord(value.runtime)
    && isRecord(value.request)
    && typeof value.request.id === 'string';
}

function isResponseMessage(value: unknown): value is ResponseMessage {
  return isRecord(value)
    && value.protocol === BROADCAST_PROTOCOL
    && value.kind === 'response'
    && isRecord(value.runtime)
    && typeof value.requestId === 'string'
    && isRecord(value.response);
}

/** Runtime-side carrier for a top-level Tauri WebView. It exposes the canonical service and no Runtime objects. */
export function installBroadcastViewportRuntimeHost(options: {
  readonly runtime: ViewportRuntimeIdentity;
  readonly service: TransportService;
  readonly channelName?: string;
  readonly createChannel?: ChannelFactory;
}): () => void {
  const channel = (options.createChannel ?? defaultFactory)(
    options.channelName ?? VIEWPORT_RUNTIME_BROADCAST_CHANNEL,
  );
  let disposed = false;
  const publishReady = (): void => channel.postMessage({
    protocol: BROADCAST_PROTOCOL,
    kind: 'ready',
    runtime: options.runtime,
  } satisfies ReadyMessage);
  const onMessage = (event: MessageEvent<unknown>): void => {
    if (!isRequestMessage(event.data) || !sameRuntime(options.runtime, event.data.runtime)) return;
    const request = event.data.request;
    void options.service.handle(request).then((response) => {
      if (disposed) return;
      channel.postMessage({
        protocol: BROADCAST_PROTOCOL,
        kind: 'response',
        runtime: options.runtime,
        requestId: request.id,
        response,
      } satisfies ResponseMessage);
    });
  };
  channel.addEventListener('message', onMessage);
  publishReady();
  const readyTimer = globalThis.setInterval(publishReady, 500);
  return () => {
    disposed = true;
    globalThis.clearInterval(readyTimer);
    channel.removeEventListener('message', onMessage);
    channel.close();
  };
}

/** Shell-side request client for the Tauri WebView carrier. */
export function createBroadcastViewportRuntimeClient(options: {
  readonly runtime: ViewportRuntimeIdentity;
  readonly channelName?: string;
  readonly timeoutMs?: number;
  readonly createChannel?: ChannelFactory;
}): MessagePortTransportClient {
  const channel = (options.createChannel ?? defaultFactory)(
    options.channelName ?? VIEWPORT_RUNTIME_BROADCAST_CHANNEL,
  );
  const pending = new Map<string, {
    readonly resolve: (response: TransportResponse) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }>();
  let disposed = false;
  const onMessage = (event: MessageEvent<unknown>): void => {
    if (!isResponseMessage(event.data) || !sameRuntime(options.runtime, event.data.runtime)) return;
    const entry = pending.get(event.data.requestId);
    if (entry === undefined) return;
    pending.delete(event.data.requestId);
    clearTimeout(entry.timer);
    entry.resolve(event.data.response);
  };
  channel.addEventListener('message', onMessage);
  return {
    request(request): Promise<TransportResponse> {
      if (disposed) return Promise.reject(new Error('viewport-runtime-client-disposed'));
      if (pending.has(request.id)) return Promise.reject(new Error('viewport-runtime-request-duplicate'));
      return new Promise<TransportResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(request.id);
          reject(new Error('viewport-runtime-request-timeout'));
        }, options.timeoutMs ?? 5_000);
        pending.set(request.id, { resolve, reject, timer });
        channel.postMessage({
          protocol: BROADCAST_PROTOCOL,
          kind: 'request',
          runtime: options.runtime,
          request,
        } satisfies RequestMessage);
      });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      channel.removeEventListener('message', onMessage);
      channel.close();
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('viewport-runtime-client-disposed'));
      }
      pending.clear();
    },
  };
}

/** Observe Tauri Runtime generations without creating a second authority. */
export function subscribeBroadcastViewportRuntimeReady(
  listener: (runtime: ViewportRuntimeIdentity) => void,
  options: { readonly channelName?: string; readonly createChannel?: ChannelFactory } = {},
): () => void {
  const channel = (options.createChannel ?? defaultFactory)(
    options.channelName ?? VIEWPORT_RUNTIME_BROADCAST_CHANNEL,
  );
  const onMessage = (event: MessageEvent<unknown>): void => {
    if (isReadyMessage(event.data)) listener(event.data.runtime);
  };
  channel.addEventListener('message', onMessage);
  return () => {
    channel.removeEventListener('message', onMessage);
    channel.close();
  };
}
