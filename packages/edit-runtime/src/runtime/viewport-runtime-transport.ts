import {
  TRANSPORT_PROTOCOL_VERSION,
  createMessagePortCarrier,
  createReferenceCreationEntry,
  RunJournal,
  createTransportSecurityPolicy,
  createTransportService,
  isViewportCarrierKind,
  isViewportRuntimeIdentity,
  type TransportMessagePort,
  type OperationRun,
  type OperationRunAcceptResult,
  type MessagePortTransportClient,
  type TransportResponse,
  type TransportService,
  type ViewportProjectionEnvelope,
  type ViewportRuntimeIdentity,
  type ReferenceCreationEntry,
  type ReferenceCreationJournalStore,
} from '@forgeax/editor-product';
import {
  createGatewayCapabilityAdapter,
  createRuntimeUiOperations,
  entComponents,
  entExists,
  entName,
  ensureAssetCataloged,
  getAssetSelectionList,
  getEditorWorldProjection,
  getLastSelectionDomain,
  getPathSelectionList,
  getSelectionList,
  type AssetBrowserRegistryEntry,
  type EditGateway,
  type MaterialPublicationInspection,
  type RuntimeUiGraph,
  type VersionControlSnapshot,
} from '@forgeax/editor-core';
import {
  createHierarchyStructureSelector,
  type HierarchyRuntimeProjection,
} from '@forgeax/editor-panels/hierarchy-projection';
import type { InspectorRuntimeProjection } from '@forgeax/editor-panels/inspector-runtime-projection';
import type { ExecutionReport } from '@forgeax/engine-app';
import type { RuntimeAssetBinding } from '@forgeax/engine-types';
import type { DiagnosticsSnapshot } from '@forgeax/editor-core';
import {
  createPreviewExecutorClient,
  isPreviewExecutorLeaseIdentity,
  samePreviewExecutorLease,
  type PreviewExecutorClient,
  type PreviewExecutorLeaseIdentity,
} from './preview-executor-lease';

export const VIEWPORT_RUNTIME_CONNECT = 'FORGEAX_VIEWPORT_RUNTIME_CONNECT' as const;
export const VIEWPORT_RUNTIME_CONNECTED = 'FORGEAX_VIEWPORT_RUNTIME_CONNECTED' as const;
export const VIEWPORT_RUNTIME_READY = 'FORGEAX_VIEWPORT_RUNTIME_READY' as const;
export const VIEWPORT_RUNTIME_PROJECTION_INVALIDATED = 'FORGEAX_VIEWPORT_RUNTIME_PROJECTION_INVALIDATED' as const;
export const VIEWPORT_RUNTIME_OPEN_ASSET = 'FORGEAX_VIEWPORT_RUNTIME_OPEN_ASSET' as const;
export const VIEWPORT_PREVIEW_EXECUTOR_CONNECT = 'FORGEAX_VIEWPORT_PREVIEW_EXECUTOR_CONNECT' as const;
export const VIEWPORT_PREVIEW_EXECUTOR_CONNECTED = 'FORGEAX_VIEWPORT_PREVIEW_EXECUTOR_CONNECTED' as const;
export const VIEWPORT_PREVIEW_EXECUTOR_DISCONNECT = 'FORGEAX_VIEWPORT_PREVIEW_EXECUTOR_DISCONNECT' as const;

export interface ViewportRuntimeConnectMessage {
  readonly type: typeof VIEWPORT_RUNTIME_CONNECT;
  readonly challenge: string;
  readonly runtime: ViewportRuntimeIdentity;
}

export interface ViewportRuntimeConnectedMessage {
  readonly type: typeof VIEWPORT_RUNTIME_CONNECTED;
  readonly challenge: string;
  readonly runtime: ViewportRuntimeIdentity;
}

export interface ViewportRuntimeReadyMessage {
  readonly type: typeof VIEWPORT_RUNTIME_READY;
  readonly runtime: ViewportRuntimeIdentity;
}

export interface ViewportRuntimeProjectionInvalidatedMessage {
  readonly type: typeof VIEWPORT_RUNTIME_PROJECTION_INVALIDATED;
  readonly runtime: ViewportRuntimeIdentity;
  readonly projection: 'operations' | 'capabilities' | 'assets';
  readonly revision: number;
  readonly guid?: string;
}

export interface ViewportRuntimeOpenAssetMessage {
  readonly type: typeof VIEWPORT_RUNTIME_OPEN_ASSET;
  readonly runtime: ViewportRuntimeIdentity;
  readonly asset: {
    readonly guid: string;
    readonly kind: string;
    readonly name: string;
    readonly payload: Record<string, unknown>;
    readonly packPath: string;
  };
}

export interface ViewportPreviewExecutorConnectMessage {
  readonly type: typeof VIEWPORT_PREVIEW_EXECUTOR_CONNECT;
  readonly challenge: string;
  readonly runtime: ViewportRuntimeIdentity;
  readonly lease: PreviewExecutorLeaseIdentity;
}

export interface ViewportPreviewExecutorConnectedMessage {
  readonly type: typeof VIEWPORT_PREVIEW_EXECUTOR_CONNECTED;
  readonly challenge: string;
  readonly runtime: ViewportRuntimeIdentity;
  readonly lease: PreviewExecutorLeaseIdentity;
}

export interface ViewportPreviewExecutorDisconnectMessage {
  readonly type: typeof VIEWPORT_PREVIEW_EXECUTOR_DISCONNECT;
  readonly challenge: string;
  readonly runtime: ViewportRuntimeIdentity;
  readonly lease: PreviewExecutorLeaseIdentity;
}

export interface ViewportRuntimeMessageSource {
  postMessage(message: unknown, targetOrigin: string): void;
}

interface RuntimeMessageEvent {
  readonly data: unknown;
  readonly origin: string;
  readonly source: ViewportRuntimeMessageSource | null;
  readonly ports: readonly TransportMessagePort[];
}

export interface ViewportRuntimeMessageTarget {
  addEventListener(type: 'message', listener: (event: RuntimeMessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: RuntimeMessageEvent) => void): void;
}

export interface ViewportRuntimeConnectionHostOptions {
  readonly target: ViewportRuntimeMessageTarget;
  readonly expectedSource: ViewportRuntimeMessageSource;
  readonly expectedOrigin: string;
  readonly runtime: ViewportRuntimeIdentity;
  readonly service: TransportService;
  /** Bind a reverse Shell preview executor into Runtime-owned capabilities.
   * The generic authenticated carrier knows no VFX/material/mesh schemas. */
  readonly onPreviewExecutorLeaseConnect?: (
    lease: PreviewExecutorLeaseIdentity,
    client: PreviewExecutorClient,
  ) => () => void;
  readonly onReject?: (reason: string, received: unknown) => void;
}

export interface DisposableViewportRuntimeTransportService extends TransportService {
  dispose(): void;
}

export function createViewportReferenceCreationJournalStore(
  runtime: ViewportRuntimeIdentity,
  scope: ViewportRuntimeCreationScope,
): ReferenceCreationJournalStore | undefined {
  if (typeof globalThis.localStorage === 'undefined') return undefined;
  const gameRoot = scope.gameRoot.trim();
  const sceneId = scope.sceneId.trim();
  if (gameRoot === '' || sceneId === '') return undefined;
  const key = [
    'forgeax-reference-creation-journal',
    encodeURIComponent(gameRoot),
    encodeURIComponent(sceneId),
    encodeURIComponent(runtime.runtimeId),
  ].join(':');
  return {
    read: () => {
      const raw = globalThis.localStorage.getItem(key);
      if (raw === null) return [];
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return raw;
      }
    },
    write: (records) => {
      globalThis.localStorage.setItem(key, JSON.stringify(records));
    },
  };
}

function createReferenceCreationGateway(gateway: EditGateway) {
  const query = gateway.buildQueryFn();
  return {
    listOps: () => gateway.listOps() as never,
    assetCatalog: () => gateway.assetCatalog() as never,
    query: (input: { readonly with: readonly ['Name'] }) => query({ with: [...input.with] }) as never,
    dispatch: (command: Record<string, unknown>, origin: 'ai') => gateway.dispatch(command as never, origin) as never,
    getOperationRunResult: (requestId: string) => gateway.getOperationRunResult(requestId) as never,
    waitOperationRun: async (requestId: string) => await gateway.waitOperationRun(requestId) as never,
    reconnect: (previousCapabilityGeneration: string) => {
      void previousCapabilityGeneration;
      gateway.reconnectCapabilitySnapshot();
    },
  };
}

function persistedVisualReview(
  entry: ReferenceCreationEntry,
  expectation: ViewportVisualReviewExpectation,
  creationRunId: string,
): ViewportVisualReviewFacts | undefined {
  const records = entry.journal(creationRunId);
  const record = [...records].reverse().find((candidate) => (
    candidate.creationRunId === creationRunId
      && candidate.kind === 'visual-review-committed'
      && candidate.expectation === expectation
  ));
  return record as ViewportVisualReviewFacts | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isViewportRuntimeOpenAssetMessage(value: unknown): value is ViewportRuntimeOpenAssetMessage {
  if (!isRecord(value) || value.type !== VIEWPORT_RUNTIME_OPEN_ASSET || !isViewportRuntimeIdentity(value.runtime)) return false;
  const asset = value.asset;
  return isRecord(asset)
    && typeof asset.guid === 'string'
    && typeof asset.kind === 'string'
    && typeof asset.name === 'string'
    && isRecord(asset.payload)
    && typeof asset.packPath === 'string';
}

export function viewportRuntimeTransportScope(runtime: ViewportRuntimeIdentity): string {
  return `viewport:${runtime.runtimeId}:${runtime.runtimeGeneration}`;
}

/** A transport can be accepted only while its carrier generation is live. */
export function isViewportRuntimeGenerationReady(
  runtime: ViewportRuntimeIdentity,
  activeGeneration: number,
  ready: boolean,
): boolean {
  return ready && runtime.runtimeGeneration === activeGeneration;
}

type ViewportRuntimeServiceLifecycleState = 'active' | 'stale' | 'disposed';

interface ViewportRuntimeServiceLifecycle {
  readonly key: string;
  readonly runtimeGeneration: number;
  state: ViewportRuntimeServiceLifecycleState;
}

const activeViewportRuntimeServices = new Map<string, ViewportRuntimeServiceLifecycle>();

function viewportRuntimeServiceKey(runtime: ViewportRuntimeIdentity, scope: ViewportRuntimeCreationScope): string {
  return [scope.gameRoot.trim(), scope.sceneId.trim(), runtime.runtimeId].join('\u0000');
}

function pendingViewportRuntimeLifecycle(runtime: ViewportRuntimeIdentity, scope: ViewportRuntimeCreationScope): ViewportRuntimeServiceLifecycle {
  const key = viewportRuntimeServiceKey(runtime, scope);
  const current = activeViewportRuntimeServices.get(key);
  return {
    key,
    runtimeGeneration: runtime.runtimeGeneration,
    state: current !== undefined && current.runtimeGeneration >= runtime.runtimeGeneration ? 'stale' : 'active',
  };
}

function commitViewportRuntimeService(lifecycle: ViewportRuntimeServiceLifecycle): boolean {
  const current = activeViewportRuntimeServices.get(lifecycle.key);
  if (current !== undefined && current.runtimeGeneration >= lifecycle.runtimeGeneration) {
    lifecycle.state = 'stale';
    return false;
  }
  if (current !== undefined) current.state = 'stale';
  activeViewportRuntimeServices.set(lifecycle.key, lifecycle);
  return true;
}

function viewportRuntimeLifecycleError(lifecycle: ViewportRuntimeServiceLifecycle): NonNullable<TransportResponse['error']> {
  return {
    code: lifecycle.state === 'disposed' ? 'transport-port-disposed' : 'host-restarted',
    hint: lifecycle.state === 'disposed'
      ? 'The viewport Runtime transport service has been disposed.'
      : 'A newer viewport Runtime generation superseded this transport service.',
    retryable: false,
    recoveryActions: ['transport.describe', 'scope.select'],
  };
}

function viewportRuntimeLifecycleResponse(request: Parameters<TransportService['handle']>[0], lifecycle: ViewportRuntimeServiceLifecycle): TransportResponse {
  return {
    jsonrpc: '2.0',
    version: TRANSPORT_PROTOCOL_VERSION,
    id: request.id,
    correlationId: request.correlationId,
    error: viewportRuntimeLifecycleError(lifecycle),
  };
}

function viewportRuntimeLifecycleLine(lifecycle: ViewportRuntimeServiceLifecycle): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    version: TRANSPORT_PROTOCOL_VERSION,
    id: 'viewport-runtime-lifecycle',
    correlationId: 'viewport-runtime-lifecycle',
    error: viewportRuntimeLifecycleError(lifecycle),
  });
}

function fencedViewportRuntimeService(lifecycle: ViewportRuntimeServiceLifecycle): DisposableViewportRuntimeTransportService {
  return {
    handle: async (request) => viewportRuntimeLifecycleResponse(request, lifecycle),
    handleLine: async () => viewportRuntimeLifecycleLine(lifecycle),
    getRun: () => ({ ok: false, error: viewportRuntimeLifecycleError(lifecycle) }) as ReturnType<TransportService['getRun']>,
    listEvents: () => Object.assign([], { ok: false, error: viewportRuntimeLifecycleError(lifecycle) }) as ReturnType<TransportService['listEvents']>,
    dispose: () => {
      if (lifecycle.state === 'active') lifecycle.state = 'disposed';
    },
  };
}

/**
 * PanelShell Play/Stop enablement (`panel.viewport.mounted`) follows the
 * in-process Runtime client. Iframe carriers handshake a MessagePort with the
 * parent; every same-window host — including Tauri `tauri-webview` popouts and
 * WebView2 wrappers where `window.parent !== window` — must still bind locally
 * or the viewport toolbar stays disabled.
 */
export function shouldBindInProcessViewportRuntimeClient(carrierKind: string): boolean {
  return carrierKind !== 'iframe';
}

/**
 * Adapt the canonical Runtime service to the panel client contract when the
 * Runtime and shell live in the same window. This keeps in-process Studio on
 * the same typed request path as the MessagePort carrier without inventing a
 * second Gateway or projection implementation.
 */
export function createInProcessViewportRuntimeClient(service: TransportService): MessagePortTransportClient {
  let disposed = false;
  return {
    request(request) {
      if (disposed) return Promise.reject(new Error('viewport-runtime-client-disposed'));
      return service.handle(request);
    },
    dispose() {
      disposed = true;
    },
  };
}

export function readViewportRuntimeIdentity(
  search: string,
  randomId: () => string = () => crypto.randomUUID(),
): ViewportRuntimeIdentity {
  const params = new URLSearchParams(search);
  const nonce = randomId();
  const requestedKind = params.get('carrierKind');
  const carrierKind = isViewportCarrierKind(requestedKind) ? requestedKind : 'local';
  const requestedGeneration = Number(params.get('runtimeGeneration') ?? 1);
  const runtimeGeneration = Number.isSafeInteger(requestedGeneration) && requestedGeneration > 0
    ? requestedGeneration : 1;
  return {
    version: 'viewport-runtime/v1',
    runtimeId: params.get('runtimeId')?.trim() || `visible-${nonce}`,
    runtimeGeneration,
    carrierId: params.get('carrierId')?.trim() || `${carrierKind}-${nonce}`,
    carrierKind,
  };
}

export function readViewportRuntimeHostOrigin(search: string, ownOrigin: string): string {
  const requested = new URLSearchParams(search).get('hostOrigin');
  if (requested === null || requested.trim() === '') return ownOrigin;
  try {
    return new URL(requested).origin;
  } catch {
    return ownOrigin;
  }
}

export function isViewportRuntimeConnectMessage(value: unknown): value is ViewportRuntimeConnectMessage {
  return isRecord(value)
    && value.type === VIEWPORT_RUNTIME_CONNECT
    && typeof value.challenge === 'string'
    && value.challenge.length > 0
    && isViewportRuntimeIdentity(value.runtime);
}

export function isViewportRuntimeReadyMessage(value: unknown): value is ViewportRuntimeReadyMessage {
  return isRecord(value)
    && value.type === VIEWPORT_RUNTIME_READY
    && isViewportRuntimeIdentity(value.runtime);
}

export function isViewportRuntimeConnectedMessage(value: unknown): value is ViewportRuntimeConnectedMessage {
  return isRecord(value)
    && value.type === VIEWPORT_RUNTIME_CONNECTED
    && typeof value.challenge === 'string'
    && value.challenge.length > 0
    && isViewportRuntimeIdentity(value.runtime);
}

export function isViewportRuntimeProjectionInvalidatedMessage(
  value: unknown,
): value is ViewportRuntimeProjectionInvalidatedMessage {
  return isRecord(value)
    && value.type === VIEWPORT_RUNTIME_PROJECTION_INVALIDATED
    && isViewportRuntimeIdentity(value.runtime)
    && (value.projection === 'operations' || value.projection === 'capabilities' || value.projection === 'assets')
    && Number.isSafeInteger(value.revision)
    && (value.revision as number) >= 0
    && (value.guid === undefined || typeof value.guid === 'string')
    && (value.projection !== 'assets' || (typeof value.guid === 'string' && value.guid.length > 0));
}

export function isViewportPreviewExecutorConnectMessage(
  value: unknown,
): value is ViewportPreviewExecutorConnectMessage {
  return isRecord(value)
    && value.type === VIEWPORT_PREVIEW_EXECUTOR_CONNECT
    && typeof value.challenge === 'string'
    && value.challenge.length > 0
    && isViewportRuntimeIdentity(value.runtime)
    && isPreviewExecutorLeaseIdentity(value.lease);
}

export function isViewportPreviewExecutorConnectedMessage(
  value: unknown,
): value is ViewportPreviewExecutorConnectedMessage {
  return isRecord(value)
    && value.type === VIEWPORT_PREVIEW_EXECUTOR_CONNECTED
    && typeof value.challenge === 'string'
    && value.challenge.length > 0
    && isViewportRuntimeIdentity(value.runtime)
    && isPreviewExecutorLeaseIdentity(value.lease);
}

export function isViewportPreviewExecutorDisconnectMessage(
  value: unknown,
): value is ViewportPreviewExecutorDisconnectMessage {
  return isRecord(value)
    && value.type === VIEWPORT_PREVIEW_EXECUTOR_DISCONNECT
    && typeof value.challenge === 'string'
    && value.challenge.length > 0
    && isViewportRuntimeIdentity(value.runtime)
    && isPreviewExecutorLeaseIdentity(value.lease);
}

/**
 * Accept one authenticated MessagePort from the owning shell. Source, origin,
 * challenge replay, and runtime generation are checked before the canonical
 * transport service sees any request.
 */
export function installViewportRuntimeConnectionHost(
  options: ViewportRuntimeConnectionHostOptions,
): () => void {
  let active: ReturnType<typeof createMessagePortCarrier> | null = null;
  let activeChallenge: string | null = null;
  let activePreview: {
    readonly lease: PreviewExecutorLeaseIdentity;
    readonly client: PreviewExecutorClient;
    readonly disposeBinding: () => void;
  } | null = null;
  const acceptedChallenges = new Set<string>();
  const acceptedPreviewLeaseIds = new Set<string>();
  const reject = (reason: string, value: unknown) => options.onReject?.(reason, value);
  const disconnectPreview = (): void => {
    const preview = activePreview;
    activePreview = null;
    if (preview === null) return;
    try {
      preview.disposeBinding();
    } finally {
      preview.client.dispose();
    }
  };
  const sameRuntime = (received: ViewportRuntimeIdentity): boolean => (
    received.runtimeId === options.runtime.runtimeId
    && received.runtimeGeneration === options.runtime.runtimeGeneration
    && received.carrierId === options.runtime.carrierId
    && received.carrierKind === options.runtime.carrierKind
  );
  const onMessage = (event: RuntimeMessageEvent): void => {
    // This window can also own nested Play carriers that publish VAG_* health
    // heartbeats. They are not attempts to connect to the Shell transport and
    // must not become an untrusted-source warning on every frame.
    if (!isRecord(event.data) || (
      event.data.type !== VIEWPORT_RUNTIME_CONNECT
      && event.data.type !== VIEWPORT_RUNTIME_READY
      && event.data.type !== VIEWPORT_PREVIEW_EXECUTOR_CONNECT
      && event.data.type !== VIEWPORT_PREVIEW_EXECUTOR_DISCONNECT
    )) return;
    if (event.origin !== options.expectedOrigin || event.source !== options.expectedSource) {
      reject('viewport-runtime-untrusted-source', event.data);
      return;
    }
    if (isViewportRuntimeReadyMessage(event.data)) {
      if (!sameRuntime(event.data.runtime)) {
        reject('viewport-runtime-generation-mismatch', event.data);
        return;
      }
      options.expectedSource.postMessage(event.data, event.origin);
      return;
    }
    if (isViewportPreviewExecutorDisconnectMessage(event.data)) {
      if (!sameRuntime(event.data.runtime) || event.data.challenge !== activeChallenge) {
        reject('viewport-preview-executor-generation-mismatch', event.data);
        return;
      }
      if (activePreview !== null && samePreviewExecutorLease(activePreview.lease, event.data.lease)) {
        disconnectPreview();
      }
      return;
    }
    if (isViewportPreviewExecutorConnectMessage(event.data)) {
      if (!sameRuntime(event.data.runtime) || event.data.challenge !== activeChallenge) {
        reject('viewport-preview-executor-generation-mismatch', event.data);
        return;
      }
      if (acceptedPreviewLeaseIds.has(event.data.lease.leaseId)) {
        reject('viewport-preview-executor-lease-replayed', event.data);
        return;
      }
      const port = event.ports[0];
      if (port === undefined) {
        reject('viewport-preview-executor-port-missing', event.data);
        return;
      }
      if (options.onPreviewExecutorLeaseConnect === undefined) {
        port.close?.();
        reject('viewport-preview-executor-unsupported', event.data);
        return;
      }
      disconnectPreview();
      const client = createPreviewExecutorClient(port, event.data.lease);
      let disposeBinding: () => void;
      try {
        disposeBinding = options.onPreviewExecutorLeaseConnect(event.data.lease, client);
      } catch (cause) {
        client.dispose();
        reject('viewport-preview-executor-bind-failed', cause);
        return;
      }
      acceptedPreviewLeaseIds.add(event.data.lease.leaseId);
      activePreview = { lease: event.data.lease, client, disposeBinding };
      event.source.postMessage({
        type: VIEWPORT_PREVIEW_EXECUTOR_CONNECTED,
        challenge: event.data.challenge,
        runtime: options.runtime,
        lease: event.data.lease,
      } satisfies ViewportPreviewExecutorConnectedMessage, event.origin);
      return;
    }
    if (!isViewportRuntimeConnectMessage(event.data)) {
      reject('viewport-runtime-connect-invalid', event.data);
      return;
    }
    const message = event.data;
    if (!sameRuntime(message.runtime)) {
      reject('viewport-runtime-generation-mismatch', message);
      return;
    }
    if (acceptedChallenges.has(message.challenge)) {
      reject('viewport-runtime-challenge-replayed', message);
      return;
    }
    const port = event.ports[0];
    if (port === undefined) {
      reject('viewport-runtime-port-missing', message);
      return;
    }

    acceptedChallenges.add(message.challenge);
    disconnectPreview();
    acceptedPreviewLeaseIds.clear();
    active?.dispose();
    active = createMessagePortCarrier(port, options.service);
    activeChallenge = message.challenge;
    event.source.postMessage({
      type: VIEWPORT_RUNTIME_CONNECTED,
      challenge: message.challenge,
      runtime: options.runtime,
    } satisfies ViewportRuntimeConnectedMessage, event.origin);
  };

  options.target.addEventListener('message', onMessage);
  options.expectedSource.postMessage({
    type: VIEWPORT_RUNTIME_READY,
    runtime: options.runtime,
  } satisfies ViewportRuntimeReadyMessage, options.expectedOrigin);
  return () => {
    options.target.removeEventListener('message', onMessage);
    disconnectPreview();
    active?.dispose();
    active = null;
    activeChallenge = null;
  };
}

type ProjectionQuery =
  | { readonly kind: 'runtime-ui.diagnostics' }
  | { readonly kind: 'diagnostics.snapshot' }
  | { readonly kind: 'material.inspection'; readonly guid: string }
  | { readonly kind: 'engine.execution' }
  | { readonly kind: 'viewport.status' }
  | { readonly kind: 'hierarchy.structure' }
  | { readonly kind: 'inspector.selection' }
  | { readonly kind: 'selection.current' }
  | { readonly kind: 'scene.readModel' }
  | { readonly kind: 'assets.catalog'; readonly compatibleWith?: string }
  | { readonly kind: 'assets.runtime-binding' }
  | { readonly kind: 'assets.payload'; readonly guid: string }
  | { readonly kind: 'operations.snapshot' }
  | { readonly kind: 'version-control.snapshot'; readonly refresh?: boolean }
  | { readonly kind: 'reference-creation.visual-review'; readonly expectation: ViewportVisualReviewExpectation; readonly creationRunId: string }
  | { readonly kind: 'world.snapshot'; readonly with: readonly string[] };

function parseProjectionQuery(value: unknown): ProjectionQuery | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'runtime-ui.diagnostics') return { kind: value.kind };
  if (value.kind === 'diagnostics.snapshot') return { kind: value.kind };
  if (value.kind === 'material.inspection' && typeof value.guid === 'string' && value.guid.length > 0) {
    return { kind: value.kind, guid: value.guid };
  }
  if (value.kind === 'engine.execution') return { kind: value.kind };
  if (value.kind === 'viewport.status') return { kind: value.kind };
  if (value.kind === 'hierarchy.structure') return { kind: value.kind };
  if (value.kind === 'inspector.selection') return { kind: value.kind };
  if (value.kind === 'selection.current') return { kind: value.kind };
  if (value.kind === 'scene.readModel') return { kind: value.kind };
  if (value.kind === 'assets.catalog') {
    return {
      kind: value.kind,
      ...(typeof value.compatibleWith === 'string' && value.compatibleWith.length > 0
        ? { compatibleWith: value.compatibleWith }
        : {}),
    };
  }
  if (value.kind === 'assets.runtime-binding') return { kind: value.kind };
  if (value.kind === 'assets.payload' && typeof value.guid === 'string' && value.guid.length > 0) {
    return { kind: value.kind, guid: value.guid };
  }
  if (value.kind === 'operations.snapshot') return { kind: value.kind };
  if (value.kind === 'version-control.snapshot') {
    return value.refresh === true ? { kind: value.kind, refresh: true } : { kind: value.kind };
  }
  if ((value.kind === 'reference-creation.visual-review')
    && (value.expectation === 'edit-prop-after-reopen' || value.expectation === 'play-prop-roundtrip')
    && typeof value.creationRunId === 'string'
    && value.creationRunId.trim() !== '') {
    return { kind: value.kind, expectation: value.expectation, creationRunId: value.creationRunId.trim() };
  }
  if (value.kind === 'world.snapshot'
    && Array.isArray(value.with)
    && value.with.every((entry) => typeof entry === 'string' && entry.length > 0)
  ) return { kind: value.kind, with: value.with as readonly string[] };
  return null;
}

function projectionError(code: string, hint: string) {
  return { code, hint, retryable: true, recoveryActions: ['query', 'transport.reconnect'] } as const;
}

type ViewportProjectionQueryOptions = {
  readonly runtime: ViewportRuntimeIdentity;
  readonly graph: RuntimeUiGraph;
  readonly gateway: Pick<EditGateway, 'buildQueryFn'>;
  readonly readHierarchy?: () => HierarchyRuntimeProjection | undefined;
  readonly readInspector?: () => InspectorRuntimeProjection;
  readonly readAssetCatalog?: (compatibleWith?: string) => readonly AssetBrowserRegistryEntry[];
  readonly readRuntimeBinding?: () => RuntimeAssetBinding | undefined;
  readonly readAssetPayload?: (guid: string) => unknown | Promise<unknown>;
  readonly readOperationRuns?: () => { readonly revision: number; readonly runs: readonly OperationRun[] };
  readonly readVersionControlSnapshot?: () => VersionControlSnapshot | undefined;
  readonly readVisualReview?: (expectation: ViewportVisualReviewExpectation, creationRunId: string) => unknown;
  readonly readViewportStatus?: () => unknown;
  readonly readDiagnostics?: () => DiagnosticsSnapshot;
  readonly readMaterialInspection?: (guid: string) => MaterialPublicationInspection | undefined;
  readonly readExecutionReport?: () => ExecutionReport;
  /** Re-read the Host-owned repository status when a caller asks for a fresh snapshot. */
  readonly refreshVersionControlSnapshot?: () => VersionControlSnapshot | Promise<VersionControlSnapshot>;
};

export type ViewportVisualReviewExpectation = 'edit-prop-after-reopen' | 'play-prop-roundtrip';

export interface ViewportRuntimeCreationScope {
  readonly gameRoot: string;
  readonly sceneId: string;
}

export interface ViewportVisualReviewFacts {
  readonly authoredBy: 'verify';
  readonly executor: 'step-verify-visual-executor';
  readonly expectation: ViewportVisualReviewExpectation;
  readonly observed: Readonly<Record<string, unknown>>;
  readonly verdict: 'pass' | 'fail' | 'unproven';
  readonly confidence: number;
  readonly mismatchReason?: string;
  readonly capture: { readonly runId: string; readonly tapePath: string; readonly reportPath: string };
  readonly renderer: { readonly backend: string; readonly generation: number; readonly carrierGeneration: number; readonly rendererIdentity: string };
}

function validViewportVisualReviewFacts(value: unknown, expectation: ViewportVisualReviewExpectation): value is ViewportVisualReviewFacts {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const facts = value as Record<string, unknown>;
  const capture = facts.capture;
  const renderer = facts.renderer;
  if (facts.authoredBy !== 'verify' || facts.executor !== 'step-verify-visual-executor' || facts.expectation !== expectation
    || (facts.verdict !== 'pass' && facts.verdict !== 'fail' && facts.verdict !== 'unproven')
    || typeof facts.confidence !== 'number' || !Number.isFinite(facts.confidence) || facts.confidence < 0 || facts.confidence > 1
    || facts.observed === null || typeof facts.observed !== 'object' || Array.isArray(facts.observed)) return false;
  if (capture === null || typeof capture !== 'object' || Array.isArray(capture)) return false;
  const captureFacts = capture as Record<string, unknown>;
  if (typeof captureFacts.runId !== 'string' || captureFacts.runId.trim() === ''
    || typeof captureFacts.tapePath !== 'string' || !/(^|[\\/])frame-0\.tape\.bin$/.test(captureFacts.tapePath)
    || typeof captureFacts.reportPath !== 'string' || captureFacts.reportPath !== captureFacts.tapePath.replace(/frame-0\.tape\.bin$/, 'frame-0.report.json')) return false;
  if (renderer === null || typeof renderer !== 'object' || Array.isArray(renderer)) return false;
  const rendererFacts = renderer as Record<string, unknown>;
  return typeof rendererFacts.backend === 'string' && rendererFacts.backend.trim() !== ''
    && Number.isSafeInteger(rendererFacts.generation) && (rendererFacts.generation as number) > 0
    && Number.isSafeInteger(rendererFacts.carrierGeneration) && (rendererFacts.carrierGeneration as number) > 0
    && typeof rendererFacts.rendererIdentity === 'string' && rendererFacts.rendererIdentity.trim() !== '';
}

type SyncViewportProjectionQueryOptions = Omit<
  ViewportProjectionQueryOptions,
  'readAssetPayload' | 'refreshVersionControlSnapshot'
> & {
  readonly readAssetPayload?: undefined;
};

export function createViewportProjectionQuery(
  options: SyncViewportProjectionQueryOptions,
): (input: unknown) => ViewportProjectionEnvelope<unknown>;
export function createViewportProjectionQuery(
  options: ViewportProjectionQueryOptions,
): (input: unknown) => ViewportProjectionEnvelope<unknown> | Promise<ViewportProjectionEnvelope<unknown>>;
export function createViewportProjectionQuery(
  options: ViewportProjectionQueryOptions,
): (input: unknown) => ViewportProjectionEnvelope<unknown> | Promise<ViewportProjectionEnvelope<unknown>> {
  let revision = 0;
  const runtimeUiOperations = createRuntimeUiOperations(options.graph, 'viewport-runtime');
  return (input) => {
    revision += 1;
    const base = { version: options.runtime.version, runtime: options.runtime, revision } as const;
    const query = parseProjectionQuery(input);
    if (query === null) return {
        ...base,
        status: 'faulted',
        error: projectionError('projection-query-invalid', 'Use runtime-ui.diagnostics, diagnostics.snapshot, material.inspection with a guid, engine.execution, viewport.status, hierarchy.structure, inspector.selection, selection.current, scene.readModel, assets.catalog, assets.payload with a guid, operations.snapshot, version-control.snapshot, reference-creation.visual-review, or world.snapshot with a component-name list.'),
      };
    // Play/Stop chrome reads viewport.status from Gateway/quadrant, not from the
    // selector graph. Gating it on graph bind left the toolbar disabled whenever
    // the packaged renderer only exposes `subscribe()` / frame-submitted.
    if (query.kind !== 'viewport.status' && options.graph.stats().status !== 'bound') return {
        ...base,
        status: 'unavailable',
        error: projectionError('runtime-unavailable', 'Reconnect after the active Runtime binds its Edit World.'),
      };
    if (query.kind === 'runtime-ui.diagnostics') return {
      ...base,
      status: 'ready',
      value: runtimeUiOperations.diagnostics(),
    };
    if (query.kind === 'diagnostics.snapshot') {
      if (options.readDiagnostics === undefined) return {
        ...base,
        status: 'unavailable',
        error: projectionError(
          'runtime-diagnostics-unavailable',
          'Wait for the Runtime Gateway diagnostics provider to bind.',
        ),
      };
      return {
        ...base,
        status: 'ready',
        value: options.readDiagnostics(),
      };
    }
    if (query.kind === 'material.inspection') {
      const inspection = options.readMaterialInspection?.(query.guid);
      if (inspection === undefined) return {
        ...base,
        status: 'unavailable',
        error: projectionError(
          'material-inspection-unavailable',
          'Wait for the Runtime AssetRegistry to publish the cooked material inspection.',
        ),
      };
      return {
        ...base,
        status: 'ready',
        value: inspection,
      };
    }
    if (query.kind === 'engine.execution') {
      if (options.readExecutionReport === undefined) return {
        ...base,
        status: 'unavailable',
        error: projectionError(
          'engine-execution-unavailable',
          'Wait for the Runtime App to publish its execution control report.',
        ),
      };
      return {
        ...base,
        status: 'ready',
        value: options.readExecutionReport(),
      };
    }
    if (query.kind === 'viewport.status') return {
      ...base,
      status: 'ready',
      value: options.readViewportStatus?.() ?? null,
    };
    if (query.kind === 'hierarchy.structure') {
      const hierarchy = options.readHierarchy?.();
      if (hierarchy === undefined) return {
        ...base,
        status: 'unavailable',
        error: projectionError('projection-pending', 'Wait for the RuntimeUiGraph to publish the hierarchy baseline.'),
      };
      return hierarchy.structure.rows.length === 0
        ? { ...base, status: 'empty' }
        : { ...base, status: 'ready', value: hierarchy };
    }
    if (query.kind === 'inspector.selection') {
      const inspector = options.readInspector?.() ?? { selectionIds: [], entities: [] };
      return inspector.entity === undefined
        ? { ...base, status: 'empty' }
        : { ...base, status: 'ready', value: inspector };
    }
    if (query.kind === 'selection.current') return {
      ...base,
      status: 'ready',
      value: {
        entityIds: [...getSelectionList()],
        assets: getAssetSelectionList().map(({ guid, kind, name, packPath }) => ({ guid, kind, name, packPath })),
        paths: getPathSelectionList().map(({ path, kind }) => ({ path, kind })),
        lastDomain: getLastSelectionDomain(),
      },
    };
    if (query.kind === 'scene.readModel') return {
      ...base,
      status: 'ready',
      value: options.gateway.sceneReadModel(),
    };
    if (query.kind === 'assets.catalog') {
      const entries = options.readAssetCatalog?.(query.compatibleWith) ?? [];
      return entries.length === 0
        ? { ...base, status: 'empty' }
        : { ...base, status: 'ready', value: { entries } };
    }
    if (query.kind === 'assets.runtime-binding') {
      const binding = options.readRuntimeBinding?.();
      return binding === undefined
        ? { ...base, status: 'empty' }
        : { ...base, status: 'ready', value: binding };
    }
    if (query.kind === 'assets.payload') {
      if (options.readAssetPayload === undefined) return {
        ...base,
        status: 'unavailable',
        error: projectionError(
          'asset-payload-unavailable',
          'The Runtime AssetRegistry payload reader is not bound.',
        ),
      };
      const project = (payload: unknown): ViewportProjectionEnvelope<unknown> => (
        payload === undefined
          ? { ...base, status: 'empty' }
          : { ...base, status: 'ready', value: { guid: query.guid, payload } }
      );
      const payload = options.readAssetPayload(query.guid);
      return (payload instanceof Promise
        ? payload.then(project)
        : project(payload));
    }
    if (query.kind === 'operations.snapshot') {
      const snapshot = options.readOperationRuns?.() ?? { revision: 0, runs: [] };
      return { ...base, status: 'ready', value: snapshot };
    }
    if (query.kind === 'version-control.snapshot') {
      const snapshot = query.refresh
        ? (options.refreshVersionControlSnapshot?.() ?? options.readVersionControlSnapshot?.())
        : options.readVersionControlSnapshot?.();
      const project = (value: VersionControlSnapshot | undefined): ViewportProjectionEnvelope<unknown> => {
        if (value === undefined) return {
          ...base,
          status: 'unavailable',
          error: projectionError('version-control-unavailable', 'The Runtime version-control provider is not bound.'),
        };
        // The version-control snapshot is already a discriminated product
        // projection. Keep its uninitialized, recovery-required, running, and
        // faulted states in the value instead of collapsing them into the
        // transport envelope's generic unavailable/faulted states.
        return { ...base, status: 'ready', value };
      };
      if (snapshot instanceof Promise) return snapshot.then(project);
      return project(snapshot);
    }
    if (query.kind === 'reference-creation.visual-review') {
      const facts = options.readVisualReview?.(query.expectation, query.creationRunId);
      if (facts === undefined) return {
        ...base,
        status: 'unavailable',
        error: projectionError('visual-review-unavailable', 'Verify has not published visual review facts for this expectation.'),
      };
      return validViewportVisualReviewFacts(facts, query.expectation)
        ? { ...base, status: 'ready', value: facts }
        : { ...base, status: 'faulted', error: projectionError('visual-review-invalid', 'Verify visual review facts do not match the requested expectation, capture artifact, or renderer provenance.') };
    }
    const snapshot = options.gateway.buildQueryFn()({ with: [...query.with] });
    if (!snapshot.ok) return {
      ...base,
      status: 'faulted',
      error: projectionError(snapshot.error.code, snapshot.error.hint),
    };
    return snapshot.rows.length === 0
      ? { ...base, status: 'empty' }
      : { ...base, status: 'ready', value: snapshot };
  };
}

export function createViewportRuntimeTransportService(options: {
  readonly runtime: ViewportRuntimeIdentity;
  readonly referenceCreationScope: ViewportRuntimeCreationScope;
  readonly graph: RuntimeUiGraph;
  readonly gateway: EditGateway;
  readonly readAssetPayload?: (guid: string) => unknown | Promise<unknown>;
  readonly readMaterialInspection?: (guid: string) => MaterialPublicationInspection | undefined;
  readonly readRuntimeBinding?: () => RuntimeAssetBinding | undefined;
  readonly readViewportStatus?: () => unknown;
  readonly readExecutionReport?: () => ExecutionReport;
  readonly readVersionControlSnapshot?: () => VersionControlSnapshot | undefined;
  readonly refreshVersionControlSnapshot?: () => VersionControlSnapshot | Promise<VersionControlSnapshot>;
  readonly readVisualReview?: (expectation: ViewportVisualReviewExpectation, creationRunId: string) => ViewportVisualReviewFacts | undefined;
  readonly referenceCreationJournalStore?: ReferenceCreationJournalStore;
}): DisposableViewportRuntimeTransportService {
  const lifecycle = pendingViewportRuntimeLifecycle(options.runtime, options.referenceCreationScope);
  if (lifecycle.state === 'stale') return fencedViewportRuntimeService(lifecycle);

  const retryOperationRun = (
    requestId: string,
    retryRequestId: string,
    actor: { readonly kind: string },
  ): OperationRunAcceptResult => {
    const result = options.gateway.retryOperationRun(
      requestId,
      retryRequestId,
      actor.kind === 'human' ? 'human' : 'ai',
    );
    if (!result.ok) return { ok: false, error: result.error as unknown as import('@forgeax/editor-product').CommandError };
    const run = result.result?.operationRun as OperationRun | undefined;
    return run === undefined
      ? { ok: false, error: {
        code: 'operation-run-unavailable',
        hint: 'The Gateway retry did not publish its canonical operation run.',
        retryable: true,
        recoveryActions: ['run.get', 'editor.discover'],
      } }
      : { ok: true, runId: run.runId, reused: false, run };
  };
  let adapter: ReturnType<typeof createGatewayCapabilityAdapter> | undefined;
  let hierarchy: ReturnType<ReturnType<typeof createHierarchyStructureSelector>['mount']> | undefined;
  let transportService: TransportService | undefined;
  try {
    adapter = createGatewayCapabilityAdapter({
      listOps: () => options.gateway.listOps(),
      subscribeOps: (listener) => options.gateway.subscribeOperationCapabilities(listener),
      dispatch: (command, origin) => options.gateway.dispatch(command, origin),
      operationRuns: {
        get: (requestId) => options.gateway.getOperationRunResult(requestId),
        wait: (requestId) => options.gateway.waitOperationRun(requestId),
        subscribe: (requestId, listener) => options.gateway.subscribeOperationRun(requestId, listener),
        cancel: (requestId) => options.gateway.cancelOperationRun(requestId),
        retry: retryOperationRun,
      },
    });
    const mountedHierarchy = hierarchy = createHierarchyStructureSelector(options.graph).mount();
    const scope = viewportRuntimeTransportScope(options.runtime);
    const referenceCreation = createReferenceCreationEntry({
      gateway: createReferenceCreationGateway(options.gateway),
      journalStore: options.referenceCreationJournalStore
        ?? createViewportReferenceCreationJournalStore(options.runtime, options.referenceCreationScope),
    });
    const projectionQuery = createViewportProjectionQuery({
    ...options,
    readHierarchy: () => {
      const structure = mountedHierarchy.getSnapshot();
      return structure === undefined
        ? undefined
        : {
            structure,
            selectionIds: [...getSelectionList()],
            editorWorld: getEditorWorldProjection(),
          };
    },
    readInspector: () => {
      const selectionIds = [...getSelectionList()];
      const world = options.gateway.activeWorld;
      const entities = world === null
        ? []
        : selectionIds.flatMap((id) => {
            if (!entExists(world, id)) return [];
            const instance = options.gateway.sceneInstanceForMember(id);
            return [{
              id,
              name: entName(world, id),
              components: entComponents(world, id),
              ...(instance.ok ? { sceneInstance: { root: instance.value.root, member: id } } : {}),
            }];
          });
      const entity = entities.at(-1);
      return {
        selectionIds,
        entities,
        ...(entity === undefined ? {} : { entity }),
        editorWorld: getEditorWorldProjection(),
      };
    },
    readAssetCatalog: (compatibleWith) => {
      if (compatibleWith === undefined) return options.gateway.assetCatalog();
      const compatible = options.gateway.assetCatalog({ compatibleWith });
      return compatible.ok ? compatible.assets : [];
    },
    readAssetPayload: (guid) => options.gateway.lookupAsset(guid),
    readOperationRuns: () => options.gateway.operationRunSnapshot(),
    readVersionControlSnapshot: options.readVersionControlSnapshot,
    readDiagnostics: () => options.gateway.diagnostics.snapshot(),
    readVisualReview: (expectation, creationRunId) => persistedVisualReview(referenceCreation, expectation, creationRunId),
    });
    transportService = createTransportService({
      journal: new RunJournal({ scope }),
      referenceCreation,
      product: adapter.product(),
      operationRuns: adapter.saveOperationRuns,
      security: createTransportSecurityPolicy({
        version: TRANSPORT_PROTOCOL_VERSION,
        scopes: [scope],
        permissions: {},
      }),
      query: async (input) => {
        const parsed = parseProjectionQuery(input);
        if (parsed?.kind === 'assets.payload' && options.gateway.lookupAsset(parsed.guid) === undefined) {
          await ensureAssetCataloged(options.gateway.doc.registry, parsed.guid);
        }
        return projectionQuery(input);
      },
    });
  } catch (error) {
    hierarchy?.unsubscribe();
    adapter?.dispose();
    throw error;
  }
  if (adapter === undefined || hierarchy === undefined || transportService === undefined) {
    throw new Error('viewport-runtime-transport-construction-incomplete');
  }
  const committedAdapter = adapter;
  const committedHierarchy = hierarchy;
  const committedTransportService = transportService;
  if (!commitViewportRuntimeService(lifecycle)) {
    committedHierarchy.unsubscribe();
    committedAdapter.dispose();
    return fencedViewportRuntimeService(lifecycle);
  }
  // The runtime transport is the public owner seam for document operations.
  // Publish the callable generation only after ownership is committed, so a
  // fenced replacement cannot advertise a capability it does not serve.
  options.gateway.reconnectCapabilitySnapshot();
  let disposed = false;
  return {
    handle(request) {
      return lifecycle.state === 'active'
        ? committedTransportService.handle(request)
        : Promise.resolve(viewportRuntimeLifecycleResponse(request, lifecycle));
    },
    handleLine(line) {
      return lifecycle.state === 'active'
        ? committedTransportService.handleLine(line)
        : Promise.resolve(viewportRuntimeLifecycleLine(lifecycle));
    },
    getRun(runId) {
      return lifecycle.state === 'active'
        ? committedTransportService.getRun(runId)
        : ({ ok: false, error: viewportRuntimeLifecycleError(lifecycle) } as ReturnType<TransportService['getRun']>);
    },
    listEvents(runId) {
      return lifecycle.state === 'active'
        ? committedTransportService.listEvents(runId)
        : Object.assign([], { ok: false, error: viewportRuntimeLifecycleError(lifecycle) }) as ReturnType<TransportService['listEvents']>;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (lifecycle.state === 'active') lifecycle.state = 'disposed';
      committedHierarchy.unsubscribe();
      committedAdapter.dispose();
    },
  };
}
