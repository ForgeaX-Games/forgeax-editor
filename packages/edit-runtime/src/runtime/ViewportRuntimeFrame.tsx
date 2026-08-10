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
  queryViewportRuntimeProjection,
  retryViewportRuntimeOperationRun,
} from '@forgeax/editor-core';
import {
  installOperationProjectionSource,
  type OperationProjectionSource,
} from '@forgeax/editor-panels/operation-projection';
import {
  VIEWPORT_RUNTIME_CONNECT,
  isViewportRuntimeConnectedMessage,
  isViewportRuntimeProjectionInvalidatedMessage,
  isViewportRuntimeReadyMessage,
  type ViewportRuntimeConnectMessage,
} from './viewport-runtime-transport';

export type ViewportRuntimeFrameStatus = 'starting' | 'connecting' | 'ready' | 'faulted';

export interface ViewportRuntimeFrameProps {
  readonly src: string;
  readonly runtime: ViewportRuntimeIdentity;
  readonly title?: string;
  readonly className?: string;
  readonly onClient?: (client: MessagePortTransportClient | null) => void;
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
  onStatusChange,
}: ViewportRuntimeFrameProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const clientRef = useRef<MessagePortTransportClient | null>(null);
  const unbindClientRef = useRef<(() => void) | null>(null);
  const uninstallOperationProjectionRef = useRef<(() => void) | null>(null);
  const refreshOperationProjectionRef = useRef<(() => void) | null>(null);
  const pendingChallengeRef = useRef<string | null>(null);
  const [status, setStatus] = useState<ViewportRuntimeFrameStatus>('starting');
  const hostOrigin = globalThis.location?.origin ?? 'http://localhost';
  const runtimeUrl = useMemo(
    () => buildViewportRuntimeUrl(src, runtime, hostOrigin),
    [src, runtime.runtimeId, runtime.runtimeGeneration, runtime.carrierId, runtime.carrierKind, hostOrigin],
  );
  const runtimeOrigin = useMemo(() => new URL(runtimeUrl).origin, [runtimeUrl]);

  useEffect(() => onStatusChange?.(status), [onStatusChange, status]);

  useEffect(() => {
    const disconnect = () => {
      refreshOperationProjectionRef.current = null;
      uninstallOperationProjectionRef.current?.();
      uninstallOperationProjectionRef.current = null;
      unbindClientRef.current?.();
      unbindClientRef.current = null;
      clientRef.current?.dispose();
      clientRef.current = null;
      pendingChallengeRef.current = null;
      onClient?.(null);
    };
    const onMessage = (event: MessageEvent<unknown>) => {
      const contentWindow = frameRef.current?.contentWindow;
      if (contentWindow === null || contentWindow === undefined) return;
      if (event.source !== contentWindow || event.origin !== runtimeOrigin) return;

      if (isViewportRuntimeProjectionInvalidatedMessage(event.data)) {
        if (sameRuntime(runtime, event.data.runtime)) refreshOperationProjectionRef.current?.();
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
      }
    };

    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      disconnect();
    };
  }, [onClient, runtime, runtimeOrigin]);

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
