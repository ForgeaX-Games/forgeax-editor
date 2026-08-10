import {
  TRANSPORT_PROTOCOL_VERSION,
  isCapabilityDescriptor,
  isCurrentViewportRuntime,
  isViewportProjectionEnvelope,
  type CapabilityDescriptor,
  type MessagePortTransportClient,
  type TransportActor,
  type TransportResponse,
  type ViewportProjectionEnvelope,
  type ViewportRuntimeIdentity,
} from '@forgeax/editor-product';

export type ViewportRuntimeClientStatus = 'disconnected' | 'ready';

export interface ViewportRuntimeClientSnapshot {
  readonly status: ViewportRuntimeClientStatus;
  readonly runtime: ViewportRuntimeIdentity | null;
}

let active: { readonly runtime: ViewportRuntimeIdentity; readonly client: MessagePortTransportClient } | null = null;
let snapshot: ViewportRuntimeClientSnapshot = Object.freeze({ status: 'disconnected', runtime: null });
let requestSequence = 0;
const listeners = new Set<() => void>();

function publish(): void {
  for (const listener of [...listeners]) listener();
}

export function getViewportRuntimeClientSnapshot(): ViewportRuntimeClientSnapshot {
  return snapshot;
}

export function subscribeViewportRuntimeClient(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Bind the one active client cache. The returned disposer is generation-safe. */
export function bindViewportRuntimeClient(
  runtime: ViewportRuntimeIdentity,
  client: MessagePortTransportClient,
): () => void {
  const binding = { runtime, client };
  active = binding;
  snapshot = Object.freeze({ status: 'ready', runtime });
  publish();
  return () => {
    if (active !== binding) return;
    active = null;
    snapshot = Object.freeze({ status: 'disconnected', runtime: null });
    publish();
  };
}

function request(method: string, params: unknown): Promise<TransportResponse> {
  if (active === null) return Promise.reject(new Error('viewport-runtime-disconnected'));
  const id = `viewport-client-${++requestSequence}`;
  return active.client.request({
    jsonrpc: '2.0',
    version: TRANSPORT_PROTOCOL_VERSION,
    id,
    correlationId: id,
    scope: `viewport:${active.runtime.runtimeId}:${active.runtime.runtimeGeneration}`,
    method,
    params,
  });
}

export async function queryViewportRuntimeProjection<T = unknown>(
  input: unknown,
): Promise<ViewportProjectionEnvelope<T>> {
  const expected = active?.runtime;
  if (expected === undefined) throw new Error('viewport-runtime-disconnected');
  const response = await request('query', input);
  if (response.error !== undefined) throw new Error(response.error.code);
  const envelope = response.result;
  if (!isViewportProjectionEnvelope(envelope)) throw new Error('viewport-projection-invalid');
  if (!isCurrentViewportRuntime(expected, envelope.runtime)) throw new Error('viewport-runtime-stale-generation');
  return envelope as ViewportProjectionEnvelope<T>;
}

/** Discover the canonical Runtime capability manifest; the shell adds no ops. */
export async function discoverViewportRuntimeCapabilities(): Promise<readonly CapabilityDescriptor[]> {
  const response = await request('discover', {});
  if (response.error !== undefined) throw new Error(response.error.code);
  const result = response.result as { readonly capabilityManifest?: { readonly capabilities?: unknown } | null } | undefined;
  const capabilities = result?.capabilityManifest?.capabilities;
  if (!Array.isArray(capabilities) || !capabilities.every(isCapabilityDescriptor)) {
    throw new Error('viewport-capability-manifest-invalid');
  }
  return capabilities;
}

export function dispatchViewportRuntimeOperation(
  operationId: string,
  input: unknown,
  actor: TransportActor = { id: 'editor-panel', kind: 'human' },
): Promise<TransportResponse> {
  return request('run.dispatch', {
    operationId: `editor.${operationId}`,
    input,
    actor,
    sessionId: 'editor-panel',
  });
}

/** Retry a Runtime-owned operation run without creating a shell-side registry. */
export function retryViewportRuntimeOperationRun(
  requestId: string,
  retryRequestId: string,
  actor: TransportActor = { id: 'editor-panel', kind: 'human' },
): Promise<TransportResponse> {
  return request('run.retry', { requestId, retryRequestId, actor });
}
