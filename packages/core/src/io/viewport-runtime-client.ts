import {
  TRANSPORT_PROTOCOL_VERSION,
  isCapabilityDescriptor,
  isCurrentViewportRuntime,
  isViewportProjectionEnvelope,
  type CapabilityDescriptor,
  type MessagePortTransportClient,
  type TransportActor,
  type TransportRequest,
  type TransportResponse,
  type ViewportProjectionEnvelope,
  type ViewportRuntimeIdentity,
} from '@forgeax/editor-product';
import { traceHierarchyVisibility } from './hierarchy-visibility-trace';
import type { RuntimeCatalogRoot } from '@forgeax/engine-types';
import type { VersionControlSnapshot } from './version-control-schema';

export type ViewportRuntimeClientStatus = 'disconnected' | 'ready';

export interface ViewportRuntimeClientSnapshot {
  readonly status: ViewportRuntimeClientStatus;
  readonly runtime: ViewportRuntimeIdentity | null;
  readonly catalogRoots: readonly RuntimeCatalogRoot[] | null;
}

export interface ViewportRuntimeSelectionSnapshot {
  readonly entityIds: readonly number[];
  readonly assets: readonly {
    readonly guid: string;
    readonly kind: string;
    readonly name: string;
    readonly packPath: string;
  }[];
  readonly paths: readonly { readonly path: string; readonly kind: 'dir' | 'file' }[];
  readonly lastDomain: 'entity' | 'asset' | 'folder' | null;
}

/** Generation-fenced client cache for the Runtime-owned version-control read model. */
export class VersionControlSnapshotClient {
  private readonly generation: number;
  private current: VersionControlSnapshot = {
    generation: 0,
    status: 'unavailable',
    error: { code: 'version-control-unavailable', hint: 'The version-control provider is not connected.' },
  };

  constructor(generation: number) { this.generation = generation; }

  publish(next: VersionControlSnapshot): void {
    if (next.generation !== this.generation) throw new Error('version-control-stale-generation');
    this.current = next;
  }

  clear(): void {
    this.current = {
      generation: this.generation,
      status: 'unavailable',
      error: { code: 'version-control-unavailable', hint: 'The version-control provider is not connected.' },
    };
  }

  read(): VersionControlSnapshot { return this.current; }
}

const EMPTY_SELECTION: ViewportRuntimeSelectionSnapshot = Object.freeze({
  entityIds: Object.freeze([]),
  assets: Object.freeze([]),
  paths: Object.freeze([]),
  lastDomain: null,
});

let active: {
  readonly runtime: ViewportRuntimeIdentity;
  readonly client: MessagePortTransportClient;
  readonly catalogRoots: readonly RuntimeCatalogRoot[] | null;
} | null = null;
let snapshot: ViewportRuntimeClientSnapshot = Object.freeze({ status: 'disconnected', runtime: null, catalogRoots: null });
let selectionSnapshot = EMPTY_SELECTION;
export interface ViewportRuntimeHierarchyRowSnapshot {
  readonly id: number;
  readonly name: string;
  readonly typeId: string;
  readonly hidden?: boolean;
  readonly ancestorHidden?: boolean;
  readonly mobility: string;
  readonly childIds: readonly number[];
}

export interface ViewportRuntimeHierarchyStructureSnapshot {
  readonly structureEpoch: number;
  readonly projectionRevision?: number;
  readonly rows: readonly ViewportRuntimeHierarchyRowSnapshot[];
}

/** Runtime-owned hierarchy read model cached on the disposable shell. */
export interface ViewportRuntimeHierarchySnapshot {
  readonly structure: ViewportRuntimeHierarchyStructureSnapshot;
  readonly selectionIds: readonly number[];
  readonly editorWorld?: unknown;
}

let hierarchySnapshot: ViewportRuntimeHierarchySnapshot | null = null;
const hierarchyListeners = new Set<() => void>();
let shellHierarchyInvalidationListenerInstalled = false;
let requestSequence = 0;
const listeners = new Set<() => void>();

function publish(): void {
  for (const listener of [...listeners]) listener();
}

export function getViewportRuntimeClientSnapshot(): ViewportRuntimeClientSnapshot {
  return snapshot;
}

/** Disposable shell projection; the Runtime remains the only selection authority. */
export function getViewportRuntimeSelectionSnapshot(): ViewportRuntimeSelectionSnapshot {
  return selectionSnapshot;
}

function freezeHierarchySnapshot(
  value: ViewportRuntimeHierarchySnapshot,
): ViewportRuntimeHierarchySnapshot {
  return Object.freeze({
    structure: Object.freeze({
      structureEpoch: value.structure.structureEpoch,
      ...(value.structure.projectionRevision === undefined
        ? {}
        : { projectionRevision: value.structure.projectionRevision }),
      rows: Object.freeze(value.structure.rows.map((row) => Object.freeze({
        id: row.id,
        name: row.name,
        typeId: row.typeId,
        mobility: row.mobility,
        childIds: Object.freeze([...row.childIds]),
        ...(row.hidden === undefined ? {} : { hidden: row.hidden }),
        ...(row.ancestorHidden === undefined ? {} : { ancestorHidden: row.ancestorHidden }),
      }))),
    }),
    selectionIds: Object.freeze([...value.selectionIds]),
    ...(value.editorWorld === undefined ? {} : { editorWorld: value.editorWorld }),
  });
}

function isHierarchySnapshot(value: unknown): value is ViewportRuntimeHierarchySnapshot {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<ViewportRuntimeHierarchySnapshot>;
  if (!Array.isArray(candidate.selectionIds) || !candidate.structure || typeof candidate.structure !== 'object') return false;
  const structure = candidate.structure as Partial<ViewportRuntimeHierarchyStructureSnapshot>;
  return Number.isFinite(structure.structureEpoch) && Array.isArray(structure.rows);
}

function publishHierarchyListeners(): void {
  for (const listener of [...hierarchyListeners]) listener();
}

/** Carrier push or query refresh: install the shell hierarchy cache (generation-fenced). */
export function publishViewportRuntimeHierarchySnapshot(
  next: ViewportRuntimeHierarchySnapshot,
): void {
  if (active === null) {
    traceHierarchyVisibility('carrier.publish.skipped', { reason: 'client-not-bound' });
    return;
  }
  hierarchySnapshot = freezeHierarchySnapshot(next);
  traceHierarchyVisibility('carrier.publish', {
    rowCount: next.structure.rows.length,
    revision: next.structure.projectionRevision ?? next.structure.structureEpoch,
    selectionCount: next.selectionIds.length,
  });
  publishHierarchyListeners();
}

export function getViewportRuntimeHierarchySnapshot(): ViewportRuntimeHierarchySnapshot | null {
  return hierarchySnapshot;
}

export function subscribeViewportRuntimeHierarchySnapshot(listener: () => void): () => void {
  ensureShellHierarchyInvalidationListener();
  hierarchyListeners.add(listener);
  return () => hierarchyListeners.delete(listener);
}

function ensureShellHierarchyInvalidationListener(): void {
  if (shellHierarchyInvalidationListenerInstalled || typeof window === 'undefined') return;
  shellHierarchyInvalidationListenerInstalled = true;
  window.addEventListener('message', (event: MessageEvent) => {
    const data = event.data;
    if (data === null || typeof data !== 'object' || (data as { type?: unknown }).type !== 'FORGEAX_VIEWPORT_RUNTIME_PROJECTION_INVALIDATED') {
      return;
    }
    const projection = (data as { projection?: unknown }).projection;
    if (projection !== 'hierarchy') return;
    const runtime = (data as { runtime?: ViewportRuntimeIdentity }).runtime;
    traceHierarchyVisibility('carrier.message.in', {
      type: (data as { type?: unknown }).type,
      projection,
      revision: (data as { revision?: unknown }).revision,
      origin: event.origin,
      runtimeGeneration: runtime?.runtimeGeneration,
    });
    if (active === null || runtime === undefined || !isCurrentViewportRuntime(active.runtime, runtime)) {
      traceHierarchyVisibility('carrier.message.ignored', {
        reason: active === null ? 'client-not-bound' : 'stale-runtime-generation',
      });
      return;
    }
    void refreshViewportRuntimeHierarchySnapshot().catch(() => undefined);
  });
}

/** Refresh the replaceable shell hierarchy cache from the current Runtime generation. */
export async function refreshViewportRuntimeHierarchySnapshot(): Promise<ViewportRuntimeHierarchySnapshot> {
  const envelope = await queryViewportRuntimeProjection<ViewportRuntimeHierarchySnapshot>({ kind: 'hierarchy.structure' });
  if (envelope.status === 'ready' && isHierarchySnapshot(envelope.value)) {
    publishViewportRuntimeHierarchySnapshot(envelope.value);
    return hierarchySnapshot!;
  }
  if (envelope.status === 'empty') {
    publishViewportRuntimeHierarchySnapshot({
      structure: { structureEpoch: envelope.revision, rows: [] },
      selectionIds: [],
    });
    return hierarchySnapshot!;
  }
  hierarchySnapshot = null;
  publishHierarchyListeners();
  throw new Error('viewport-hierarchy-projection-invalid');
}

function relayError(request: TransportRequest, code: string, hint: string): TransportResponse {
  return {
    jsonrpc: '2.0',
    version: TRANSPORT_PROTOCOL_VERSION,
    id: request.id,
    correlationId: request.correlationId,
    error: { code, hint, retryable: true, recoveryActions: ['transport.reconnect'] },
  };
}

/** Relay one canonical request for a disposable panel window without creating a second Runtime client authority. */
export async function forwardViewportRuntimeTransportRequest(request: TransportRequest): Promise<TransportResponse> {
  const binding = active;
  if (binding === null) return relayError(request, 'viewport-runtime-disconnected', 'The authoritative Viewport Runtime is disconnected.');
  try {
    const response = await binding.client.request(request);
    if (active !== binding) {
      return relayError(request, 'viewport-runtime-stale-generation', 'The Viewport Runtime changed while the panel request was in flight.');
    }
    return response;
  } catch (error) {
    return relayError(request, 'viewport-runtime-relay-failed', error instanceof Error ? error.message : String(error));
  }
}

export function subscribeViewportRuntimeClient(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Bind the one active client cache. The returned disposer is generation-safe. */
export function bindViewportRuntimeClient(
  runtime: ViewportRuntimeIdentity,
  client: MessagePortTransportClient,
  catalogRoots?: readonly RuntimeCatalogRoot[],
): () => void {
  const roots = catalogRoots === undefined
    ? null
    : Object.freeze(catalogRoots.map((root) => Object.freeze({ ...root })));
  const binding = { runtime, client, catalogRoots: roots };
  active = binding;
  snapshot = Object.freeze({ status: 'ready', runtime, catalogRoots: roots });
  selectionSnapshot = EMPTY_SELECTION;
  hierarchySnapshot = null;
  publish();
  publishHierarchyListeners();
  return () => {
    if (active !== binding) return;
    active = null;
    snapshot = Object.freeze({ status: 'disconnected', runtime: null, catalogRoots: null });
    selectionSnapshot = EMPTY_SELECTION;
    hierarchySnapshot = null;
    publish();
    publishHierarchyListeners();
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
  const current = active?.runtime;
  if (current === undefined
    || !isCurrentViewportRuntime(expected, current)
    || expected.carrierId !== current.carrierId
    || expected.carrierKind !== current.carrierKind
  ) throw new Error('viewport-runtime-stale-generation');
  if (response.error !== undefined) throw new Error(response.error.code);
  const envelope = response.result;
  if (!isViewportProjectionEnvelope(envelope)) throw new Error('viewport-projection-invalid');
  if (!isCurrentViewportRuntime(expected, envelope.runtime)) throw new Error('viewport-runtime-stale-generation');
  return envelope as ViewportProjectionEnvelope<T>;
}

function isSelectionSnapshot(value: unknown): value is ViewportRuntimeSelectionSnapshot {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<ViewportRuntimeSelectionSnapshot>;
  return Array.isArray(candidate.entityIds)
    && candidate.entityIds.every((id) => typeof id === 'number')
    && Array.isArray(candidate.assets)
    && candidate.assets.every((asset) => asset !== null
      && typeof asset === 'object'
      && typeof asset.guid === 'string'
      && typeof asset.kind === 'string'
      && typeof asset.name === 'string'
      && typeof asset.packPath === 'string')
    && Array.isArray(candidate.paths)
    && candidate.paths.every((item) => item !== null
      && typeof item === 'object'
      && typeof item.path === 'string'
      && (item.kind === 'dir' || item.kind === 'file'))
    && (candidate.lastDomain === null
      || candidate.lastDomain === 'entity'
      || candidate.lastDomain === 'asset'
      || candidate.lastDomain === 'folder');
}

/** Refresh the replaceable shell cache from the current Runtime generation. */
export async function refreshViewportRuntimeSelectionSnapshot(): Promise<ViewportRuntimeSelectionSnapshot> {
  const envelope = await queryViewportRuntimeProjection<ViewportRuntimeSelectionSnapshot>({ kind: 'selection.current' });
  if (envelope.status !== 'ready' || !isSelectionSnapshot(envelope.value)) {
    selectionSnapshot = EMPTY_SELECTION;
    throw new Error('viewport-selection-projection-invalid');
  }
  selectionSnapshot = Object.freeze({
    entityIds: Object.freeze([...envelope.value.entityIds]),
    assets: Object.freeze(envelope.value.assets.map((asset) => Object.freeze({ ...asset }))),
    paths: Object.freeze(envelope.value.paths.map((item) => Object.freeze({ ...item }))),
    lastDomain: envelope.value.lastDomain,
  });
  return selectionSnapshot;
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
  options: { readonly async?: boolean } = {},
): Promise<TransportResponse> {
  return request('run.dispatch', {
    operationId: `editor.${operationId}`,
    input,
    actor,
    sessionId: 'editor-panel',
    ...(options.async === true ? { async: true } : {}),
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

/** Read one Runtime-owned operation run without mirroring its journal in the shell. */
export function getViewportRuntimeOperationRun(requestId: string): Promise<TransportResponse> {
  return request('run.get', { requestId });
}

/** Wait for the Runtime-owned run's terminal state. */
export function waitViewportRuntimeOperationRun(requestId: string): Promise<TransportResponse> {
  return request('run.wait', { requestId });
}

/** Request cancellation from the Runtime owner. */
export function cancelViewportRuntimeOperationRun(requestId: string): Promise<TransportResponse> {
  return request('run.cancel', { requestId });
}
