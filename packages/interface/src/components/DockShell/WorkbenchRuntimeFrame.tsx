import { useCallback, useEffect, useRef, type ReactElement, type SyntheticEvent } from 'react';
import type { WorkbenchCatalogEntry } from '@forgeax/workbench-host/browser';
import type { WorkbenchSessionContext } from '@forgeax/workbench-host/contracts';
import { WorkbenchFrame } from '@forgeax/workbench-host/react';
import { getLocale } from '@/i18n';
import type { SurfacePane } from '../../lib/platform';
import type {
  EditorAssetImportSourceHandler,
} from './panelRenderers';
import { attachWorkbenchEditorAssetImportBridge } from './workbench-editor-bridge';
import { WORKBENCH_API_BASE } from './workbenchRuntime';

export const TRUSTED_WORKBENCH_SANDBOX = 'allow-scripts allow-same-origin';

export function workbenchRuntimeUrl(
  runtimeUrl: string,
  pane?: SurfacePane,
): string {
  if (!pane) return runtimeUrl;
  const url = new URL(runtimeUrl, window.location.href);
  url.searchParams.set('pane', pane);
  return url.origin === window.location.origin
    ? `${url.pathname}${url.search}${url.hash}`
    : url.toString();
}

export function workbenchFrameContext(
  descriptor: WorkbenchCatalogEntry,
  gameId: string,
): WorkbenchSessionContext {
  const runtimeId = encodeURIComponent(descriptor.runtimeId);
  const encodedGameId = encodeURIComponent(gameId);
  return {
    extensionId: descriptor.extensionId,
    runtimeId: descriptor.runtimeId,
    gameId,
    locale: getLocale(),
    theme: 'dark',
    endpoints: {
      toolCall: `${WORKBENCH_API_BASE}tools/call`,
      gamePackage: `${WORKBENCH_API_BASE}games/${encodedGameId}/package?runtimeId=${runtimeId}`,
      extensionApi: `${WORKBENCH_API_BASE}extension/${runtimeId}?gameId=${encodedGameId}`,
      gameVersions: `${WORKBENCH_API_BASE}games/${encodedGameId}/versions`,
      gameComponents: `${WORKBENCH_API_BASE}games/${encodedGameId}/components`,
    },
    capabilities: ['workbench'],
  };
}

export function WorkbenchRuntimeFrame({
  descriptor,
  gameId,
  pane,
  onEditorAssetImport,
}: {
  descriptor: WorkbenchCatalogEntry;
  gameId: string;
  pane?: SurfacePane;
  onEditorAssetImport?: EditorAssetImportSourceHandler;
}): ReactElement {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const importHandlerRef = useRef(onEditorAssetImport);
  importHandlerRef.current = onEditorAssetImport;

  const onFrameLoad = useCallback((event: SyntheticEvent<HTMLIFrameElement>) => {
    frameRef.current = event.currentTarget;
  }, []);

  useEffect(() => {
    return attachWorkbenchEditorAssetImportBridge({
      ownerWindow: window,
      frameWindow: () => frameRef.current?.contentWindow ?? null,
      importAssetSource: (request) => {
        const handler = importHandlerRef.current;
        return handler
          ? handler(request)
          : { ok: false, error: '当前 Studio 没有可用的 Editor Gateway' };
      },
    });
  }, []);

  return (
    <WorkbenchFrame
      runtimeUrl={workbenchRuntimeUrl(descriptor.runtimeUrl, pane)}
      context={workbenchFrameContext(descriptor, gameId)}
      sandbox={TRUSTED_WORKBENCH_SANDBOX}
      title={pane ? `${descriptor.title} — ${pane}` : descriptor.title}
      data-workbench-runtime={descriptor.extensionId}
      data-workbench-pane={pane}
      style={{ display: 'block', width: '100%', height: '100%', border: 0 }}
      onLoad={onFrameLoad}
    />
  );
}
