import {
  TRANSPORT_PROTOCOL_VERSION,
  createMessagePortCarrier,
  RunJournal,
  createTransportSecurityPolicy,
  createTransportService,
  isViewportCarrierKind,
  isViewportRuntimeIdentity,
  type TransportMessagePort,
  type OperationRun,
  type OperationRunAcceptResult,
  type MessagePortTransportClient,
  type TransportService,
  type ViewportProjectionEnvelope,
  type ViewportRuntimeIdentity,
} from '@forgeax/editor-product';
import {
  createGatewayCapabilityAdapter,
  createRuntimeUiOperations,
  entComponents,
  entExists,
  entName,
  ensureAssetCataloged,
  getAssetSelectionList,
  getLastSelectionDomain,
  getPathSelectionList,
  getSelectionList,
  type AssetBrowserRegistryEntry,
  type EditGateway,
  type RuntimeUiGraph,
} from '@forgeax/editor-core';
import {
  createHierarchyStructureSelector,
  type HierarchyRuntimeProjection,
} from '@forgeax/editor-panels/hierarchy-projection';
import type { InspectorRuntimeProjection } from '@forgeax/editor-panels/inspector-runtime-projection';
import type { ExecutionReport } from '@forgeax/engine-app';
import type { DiagnosticsSnapshot } from '@forgeax/editor-core';

export const VIEWPORT_RUNTIME_CONNECT = 'FORGEAX_VIEWPORT_RUNTIME_CONNECT' as const;
export const VIEWPORT_RUNTIME_CONNECTED = 'FORGEAX_VIEWPORT_RUNTIME_CONNECTED' as const;
export const VIEWPORT_RUNTIME_READY = 'FORGEAX_VIEWPORT_RUNTIME_READY' as const;
export const VIEWPORT_RUNTIME_PROJECTION_INVALIDATED = 'FORGEAX_VIEWPORT_RUNTIME_PROJECTION_INVALIDATED' as const;
export const VIEWPORT_RUNTIME_OPEN_ASSET = 'FORGEAX_VIEWPORT_RUNTIME_OPEN_ASSET' as const;

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
  readonly projection: 'operations';
  readonly revision: number;
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
  readonly onReject?: (reason: string, received: unknown) => void;
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
    && value.projection === 'operations'
    && Number.isSafeInteger(value.revision)
    && (value.revision as number) >= 0;
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
  const acceptedChallenges = new Set<string>();
  const reject = (reason: string, value: unknown) => options.onReject?.(reason, value);
  const onMessage = (event: RuntimeMessageEvent): void => {
    // This window can also own nested Play carriers that publish VAG_* health
    // heartbeats. They are not attempts to connect to the Shell transport and
    // must not become an untrusted-source warning on every frame.
    if (!isRecord(event.data) || event.data.type !== VIEWPORT_RUNTIME_CONNECT) return;
    if (event.origin !== options.expectedOrigin || event.source !== options.expectedSource) {
      reject('viewport-runtime-untrusted-source', event.data);
      return;
    }
    if (!isViewportRuntimeConnectMessage(event.data)) {
      reject('viewport-runtime-connect-invalid', event.data);
      return;
    }
    const message = event.data;
    if (message.runtime.runtimeId !== options.runtime.runtimeId
      || message.runtime.runtimeGeneration !== options.runtime.runtimeGeneration
      || message.runtime.carrierId !== options.runtime.carrierId
      || message.runtime.carrierKind !== options.runtime.carrierKind
    ) {
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
    active?.dispose();
    active = createMessagePortCarrier(port, options.service);
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
    active?.dispose();
    active = null;
  };
}

type ProjectionQuery =
  | { readonly kind: 'runtime-ui.diagnostics' }
  | { readonly kind: 'diagnostics.snapshot' }
  | { readonly kind: 'engine.execution' }
  | { readonly kind: 'viewport.status' }
  | { readonly kind: 'hierarchy.structure' }
  | { readonly kind: 'inspector.selection' }
  | { readonly kind: 'selection.current' }
  | { readonly kind: 'assets.catalog' }
  | { readonly kind: 'assets.payload'; readonly guid: string }
  | { readonly kind: 'operations.snapshot' }
  | { readonly kind: 'world.snapshot'; readonly with: readonly string[] };

function parseProjectionQuery(value: unknown): ProjectionQuery | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'runtime-ui.diagnostics') return { kind: value.kind };
  if (value.kind === 'diagnostics.snapshot') return { kind: value.kind };
  if (value.kind === 'engine.execution') return { kind: value.kind };
  if (value.kind === 'viewport.status') return { kind: value.kind };
  if (value.kind === 'hierarchy.structure') return { kind: value.kind };
  if (value.kind === 'inspector.selection') return { kind: value.kind };
  if (value.kind === 'selection.current') return { kind: value.kind };
  if (value.kind === 'assets.catalog') return { kind: value.kind };
  if (value.kind === 'assets.payload' && typeof value.guid === 'string' && value.guid.length > 0) {
    return { kind: value.kind, guid: value.guid };
  }
  if (value.kind === 'operations.snapshot') return { kind: value.kind };
  if (value.kind === 'world.snapshot'
    && Array.isArray(value.with)
    && value.with.every((entry) => typeof entry === 'string' && entry.length > 0)
  ) return { kind: value.kind, with: value.with as readonly string[] };
  return null;
}

function projectionError(code: string, hint: string) {
  return { code, hint, retryable: true, recoveryActions: ['query', 'transport.reconnect'] } as const;
}

export function createViewportProjectionQuery(options: {
  readonly runtime: ViewportRuntimeIdentity;
  readonly graph: RuntimeUiGraph;
  readonly gateway: Pick<EditGateway, 'buildQueryFn'>;
  readonly readHierarchy?: () => HierarchyRuntimeProjection | undefined;
  readonly readInspector?: () => InspectorRuntimeProjection;
  readonly readAssetCatalog?: () => readonly AssetBrowserRegistryEntry[];
  readonly readAssetPayload?: (guid: string) => unknown;
  readonly readOperationRuns?: () => { readonly revision: number; readonly runs: readonly OperationRun[] };
  readonly readViewportStatus?: () => unknown;
  readonly readDiagnostics?: () => DiagnosticsSnapshot;
  readonly readExecutionReport?: () => ExecutionReport;
}): (input: unknown) => ViewportProjectionEnvelope<unknown> {
  let revision = 0;
  const runtimeUiOperations = createRuntimeUiOperations(options.graph, 'viewport-runtime');
  return (input) => {
    revision += 1;
    const base = { version: options.runtime.version, runtime: options.runtime, revision } as const;
    const query = parseProjectionQuery(input);
    if (query === null) return {
      ...base,
      status: 'faulted',
      error: projectionError('projection-query-invalid', 'Use runtime-ui.diagnostics, diagnostics.snapshot, engine.execution, viewport.status, hierarchy.structure, inspector.selection, selection.current, assets.catalog, assets.payload with a guid, operations.snapshot, or world.snapshot with a component-name list.'),
    };
    if (options.graph.stats().status !== 'bound') return {
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
    if (query.kind === 'assets.catalog') {
      const entries = options.readAssetCatalog?.() ?? [];
      return entries.length === 0
        ? { ...base, status: 'empty' }
        : { ...base, status: 'ready', value: { entries } };
    }
    if (query.kind === 'assets.payload') {
      const payload = options.readAssetPayload?.(query.guid);
      return payload === undefined
        ? { ...base, status: 'empty' }
        : { ...base, status: 'ready', value: { guid: query.guid, payload } };
    }
    if (query.kind === 'operations.snapshot') {
      const snapshot = options.readOperationRuns?.() ?? { revision: 0, runs: [] };
      return { ...base, status: 'ready', value: snapshot };
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
  readonly graph: RuntimeUiGraph;
  readonly gateway: EditGateway;
  readonly readViewportStatus?: () => unknown;
  readonly readExecutionReport?: () => ExecutionReport;
}): TransportService {
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
  const adapter = createGatewayCapabilityAdapter({
    listOps: () => options.gateway.listOps(),
    dispatch: (command, origin) => options.gateway.dispatch(command, origin),
    operationRuns: {
      get: (requestId) => options.gateway.getOperationRunResult(requestId),
      wait: (requestId) => options.gateway.waitOperationRun(requestId),
      subscribe: (requestId, listener) => options.gateway.subscribeOperationRun(requestId, listener),
      cancel: (requestId) => options.gateway.cancelOperationRun(requestId),
      retry: retryOperationRun,
    },
  });
  const hierarchy = createHierarchyStructureSelector(options.graph).mount();
  const scope = viewportRuntimeTransportScope(options.runtime);
  const projectionQuery = createViewportProjectionQuery({
    ...options,
    readHierarchy: () => {
      const structure = hierarchy.getSnapshot();
      return structure === undefined
        ? undefined
        : { structure, selectionIds: [...getSelectionList()], mode: options.gateway.mode };
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
      return { selectionIds, entities, ...(entity === undefined ? {} : { entity }) };
    },
    readAssetCatalog: () => options.gateway.assetCatalog(),
    readAssetPayload: (guid) => options.gateway.lookupAsset(guid),
    readOperationRuns: () => options.gateway.operationRunSnapshot(),
    readDiagnostics: () => options.gateway.diagnostics.snapshot(),
  });
  return createTransportService({
    journal: new RunJournal({ scope }),
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
}
