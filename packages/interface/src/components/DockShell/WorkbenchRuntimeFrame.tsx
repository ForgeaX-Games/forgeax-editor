import type { ReactElement } from 'react';
import type { WorkbenchCatalogEntry } from '@forgeax/workbench-host/browser';
import type { WorkbenchSessionContext } from '@forgeax/workbench-host/contracts';
import { WorkbenchFrame } from '@forgeax/workbench-host/react';
import { getLocale } from '@/i18n';
import type { SurfacePane } from '../../lib/platform';
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
}: {
  descriptor: WorkbenchCatalogEntry;
  gameId: string;
  pane?: SurfacePane;
}): ReactElement {
  return (
    <WorkbenchFrame
      runtimeUrl={workbenchRuntimeUrl(descriptor.runtimeUrl, pane)}
      context={workbenchFrameContext(descriptor, gameId)}
      sandbox={TRUSTED_WORKBENCH_SANDBOX}
      title={pane ? `${descriptor.title} — ${pane}` : descriptor.title}
      data-workbench-runtime={descriptor.extensionId}
      data-workbench-pane={pane}
      style={{ display: 'block', width: '100%', height: '100%', border: 0 }}
    />
  );
}
