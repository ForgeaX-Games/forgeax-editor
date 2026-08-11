import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createMessagePortTransportClient,
  isCurrentViewportRuntime,
  type OperationRun,
  type MessagePortTransportClient,
  type ViewportRuntimeIdentity,
} from '@forgeax/editor-product';
import {
  bindViewportRuntimeClient,
  openEditorAssetPage,
  queryViewportRuntimeProjection,
  retryViewportRuntimeOperationRun,
} from '@forgeax/editor-core';
import {
  installOperationProjectionSource,
  type OperationProjectionSource,
} from '@forgeax/editor-panels/operation-projection';
import {
  VIEWPORT_RUNTIME_CONNECT,
  VIEWPORT_PREVIEW_EXECUTOR_CONNECT,
  VIEWPORT_PREVIEW_EXECUTOR_DISCONNECT,
  isViewportPreviewExecutorConnectedMessage,
  isViewportRuntimeConnectedMessage,
  isViewportRuntimeProjectionInvalidatedMessage,
  isViewportRuntimeOpenAssetMessage,
  isViewportRuntimeReadyMessage,
  type ViewportRuntimeConnectMessage,
  type ViewportPreviewExecutorConnectMessage,
  type ViewportPreviewExecutorDisconnectMessage,
} from './viewport-runtime-transport';
import {
  createPreviewExecutorCarrier,
  getShellPreviewExecutorLeaseSnapshot,
  markShellPreviewExecutorLeaseConnected,
  samePreviewExecutorLease,
  subscribeShellPreviewExecutorLease,
  type PreviewExecutorLeaseIdentity,
} from './preview-executor-lease';

export type ViewportRuntimeFrameStatus = 'starting' | 'connecting' | 'ready' | 'faulted';

export interface ViewportRuntimeFrameProps {
  readonly src: string;
  readonly runtime: ViewportRuntimeIdentity;
  readonly title?: string;
  readonly className?: string;
  readonly onClient?: (client: MessagePortTransportClient | null) => void;
  readonly onCapabilitiesChanged?: () => void;
  readonly onStatusChange?: (status: ViewportRuntimeFrameStatus) => void;
}

export function buildViewportRuntimeUrl(
  src: string,
  runtime: ViewportRuntimeIdentity,
  hostOrigin: string,
  baseUrl?: string,
): string {
  const url = new URL(src, baseUrl ?? globalThis.location?.href ?? 'http://localhost/');
  url.searchParams.set('runtimeId', runtime.runtimeId);
  url.searchParams.set('runtimeGeneration', String(runtime.runtimeGeneration));
  url.searchParams.set('carrierId', runtime.carrierId);
  url.searchParams.set('carrierKind', runtime.carrierKind);
  url.searchParams.set('hostOrigin', hostOrigin);
  return url.href;
}

function sameRuntime(expected: ViewportRuntimeIdentity, received: ViewportRuntimeIdentity): boolean {
  return isCurrentViewportRuntime(expected, received)
    && expected.carrierId === received.carrierId
    && expected.carrierKind === received.carrierKind;
}

/** The Shell-owned carrier. It owns the iframe and connection, never Runtime data. */
export function ViewportRuntimeFrame({
  src,
  runtime,
  title = 'ForgeaX Viewport Runtime',
  className,
  onClient,
  onCapabilitiesChanged,
  onStatusChange,
}: ViewportRuntimeFrameProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const clientRef = useRef<MessagePortTransportClient | null>(null);
  const unbindClientRef = useRef<(() => void) | null>(null);
  const uninstallOperationProjectionRef = useRef<(() => void) | null>(null);
  const refreshOperationProjectionRef = useRef<(() => void) | null>(null);
  const pendingChallengeRef = useRef<string | null>(null);
  const connectedChallengeRef = useRef<string | null>(null);
  const previewCarrierRef = useRef<{ dispose(): void } | null>(null);
  const previewLeaseRef = useRef<PreviewExecutorLeaseIdentity | null>(null);
  const [status, setStatus] = useState<ViewportRuntimeFrameStatus>('starting');
  const hostOrigin = globalThis.location?.origin ?? 'http://localhost';
  const runtimeUrl = useMemo(
    () => buildViewportRuntimeUrl(src, runtime, hostOrigin),
    [src, runtime.runtimeId, runtime.runtimeGeneration, runtime.carrierId, runtime.carrierKind, hostOrigin],
  );
  const runtimeOrigin = useMemo(() => new URL(runtimeUrl).origin, [runtimeUrl]);

  useEffect(() => onStatusChange?.(status), [onStatusChange, status]);

  useEffect(() => {
    let syncingPreviewExecutor = false;
    const postPreviewDisconnect = () => {
      const contentWindow = frameRef.current?.contentWindow;
      const challenge = connectedChallengeRef.current;
      const lease = previewLeaseRef.current;
      if (contentWindow !== null && contentWindow !== undefined && challenge !== null && lease !== null) {
        contentWindow.postMessage({
          type: VIEWPORT_PREVIEW_EXECUTOR_DISCONNECT,
          challenge,
          runtime,
          lease,
        } satisfies ViewportPreviewExecutorDisconnectMessage, runtimeOrigin);
      }
      previewCarrierRef.current?.dispose();
      previewCarrierRef.current = null;
      previewLeaseRef.current = null;
    };
    const syncPreviewExecutor = () => {
      if (syncingPreviewExecutor) return;
      syncingPreviewExecutor = true;
      try {
        const contentWindow = frameRef.current?.contentWindow;
        const challenge = connectedChallengeRef.current;
        const lease = getShellPreviewExecutorLeaseSnapshot().lease;
        if (contentWindow === null || contentWindow === undefined || challenge === null || lease === null) {
          if (previewLeaseRef.current !== null) {
            postPreviewDisconnect();
            markShellPreviewExecutorLeaseConnected(null);
          }
          return;
        }
        if (previewLeaseRef.current !== null
          && samePreviewExecutorLease(previewLeaseRef.current, lease.identity)) return;
        postPreviewDisconnect();
        const channel = new MessageChannel();
        previewCarrierRef.current = createPreviewExecutorCarrier(channel.port1, lease);
        previewLeaseRef.current = lease.identity;
        contentWindow.postMessage({
          type: VIEWPORT_PREVIEW_EXECUTOR_CONNECT,
          challenge,
          runtime,
          lease: lease.identity,
        } satisfies ViewportPreviewExecutorConnectMessage, runtimeOrigin, [channel.port2]);
      } finally {
        syncingPreviewExecutor = false;
      }
    };
    const disconnect = () => {
      postPreviewDisconnect();
      refreshOperationProjectionRef.current = null;
      uninstallOperationProjectionRef.current?.();
      uninstallOperationProjectionRef.current = null;
      unbindClientRef.current?.();
      unbindClientRef.current = null;
      clientRef.current?.dispose();
      clientRef.current = null;
      pendingChallengeRef.current = null;
      connectedChallengeRef.current = null;
      markShellPreviewExecutorLeaseConnected(null);
      onClient?.(null);
    };
    const onMessage = (event: MessageEvent<unknown>) => {
      const contentWindow = frameRef.current?.contentWindow;
      if (contentWindow === null || contentWindow === undefined) return;
      if (event.source !== contentWindow || event.origin !== runtimeOrigin) return;

      if (isViewportRuntimeProjectionInvalidatedMessage(event.data)) {
        if (sameRuntime(runtime, event.data.runtime)) {
          if (event.data.projection === 'operations') refreshOperationProjectionRef.current?.();
          else onCapabilitiesChanged?.();
        }
        return;
      }

      if (isViewportPreviewExecutorConnectedMessage(event.data)) {
        if (event.data.challenge !== connectedChallengeRef.current
          || !sameRuntime(runtime, event.data.runtime)
          || previewLeaseRef.current === null
          || !samePreviewExecutorLease(previewLeaseRef.current, event.data.lease)) {
          postPreviewDisconnect();
          return;
        }
        markShellPreviewExecutorLeaseConnected(event.data.lease);
        return;
      }

      if (isViewportRuntimeOpenAssetMessage(event.data)) {
        if (!sameRuntime(runtime, event.data.runtime)) return;
        void openEditorAssetPage({ ...event.data.asset }).catch((error) => {
          console.error('[viewport-runtime] shell failed to open the requested asset page', error);
        });
        return;
      }

      if (isViewportRuntimeReadyMessage(event.data)) {
        if (!sameRuntime(runtime, event.data.runtime)) {
          setStatus('faulted');
          return;
        }
        disconnect();
        const channel = new MessageChannel();
        const challenge = crypto.randomUUID();
        const client = createMessagePortTransportClient(channel.port1, { defaultTimeoutMs: 5_000 });
        clientRef.current = client;
        pendingChallengeRef.current = challenge;
        setStatus('connecting');
        contentWindow.postMessage({
          type: VIEWPORT_RUNTIME_CONNECT,
          challenge,
          runtime,
        } satisfies ViewportRuntimeConnectMessage, runtimeOrigin, [channel.port2]);
        return;
      }

      if (isViewportRuntimeConnectedMessage(event.data)) {
        if (event.data.challenge !== pendingChallengeRef.current || !sameRuntime(runtime, event.data.runtime)) {
          disconnect();
          setStatus('faulted');
          return;
        }
        pendingChallengeRef.current = null;
        connectedChallengeRef.current = event.data.challenge;
        const client = clientRef.current;
        if (client === null) {
          setStatus('faulted');
          return;
        }
        unbindClientRef.current = bindViewportRuntimeClient(runtime, client);
        let operationSnapshot: { readonly revision: number; readonly runs: readonly OperationRun[] } = {
          revision: 0,
          runs: [],
        };
        const operationListeners = new Set<() => void>();
        const operationSource: OperationProjectionSource = {
          getSnapshot: () => operationSnapshot,
          subscribe: (listener) => {
            operationListeners.add(listener);
            return () => operationListeners.delete(listener);
          },
          dispatchRecovery: (action, _runId, row) => {
            if (action !== 'retry' || row.requestId === undefined) return;
            void retryViewportRuntimeOperationRun(row.requestId, crypto.randomUUID())
              .then(() => refreshOperationProjectionRef.current?.())
              .catch(() => undefined);
          },
        };
        let refreshSequence = 0;
        const refreshOperations = () => {
          const sequence = ++refreshSequence;
          void queryViewportRuntimeProjection<typeof operationSnapshot>({ kind: 'operations.snapshot' })
            .then((envelope) => {
              if (sequence !== refreshSequence || envelope.status !== 'ready') return;
              operationSnapshot = envelope.value;
              for (const listener of [...operationListeners]) listener();
            })
            .catch(() => undefined);
        };
        uninstallOperationProjectionRef.current = installOperationProjectionSource(operationSource);
        refreshOperationProjectionRef.current = refreshOperations;
        refreshOperations();
        setStatus('ready');
        onClient?.(client);
        syncPreviewExecutor();
      }
    };

    window.addEventListener('message', onMessage);
    const unsubscribePreviewExecutor = subscribeShellPreviewExecutorLease(syncPreviewExecutor);
    return () => {
      window.removeEventListener('message', onMessage);
      unsubscribePreviewExecutor();
      disconnect();
    };
  }, [onCapabilitiesChanged, onClient, runtime, runtimeOrigin]);

  return (
    <iframe
      ref={frameRef}
      src={runtimeUrl}
      title={title}
      className={className}
      data-viewport-runtime-status={status}
      allow="autoplay; fullscreen; gamepad"
      onLoad={() => {
        // A Runtime can finish its boot and MessagePort handshake before the
        // iframe load event fires. Do not overwrite that authoritative state
        // with the carrier's later DOM lifecycle notification.
        if (clientRef.current === null) setStatus('starting');
      }}
      style={{ width: '100%', height: '100%', border: 0, display: 'block', background: '#16161a' }}
    />
  );
}
