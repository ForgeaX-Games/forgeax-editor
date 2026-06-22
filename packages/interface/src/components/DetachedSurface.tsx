/**
 * DetachedSurface — the root rendered inside a detached OS window.
 *
 * A detached window loads the SAME bundle as the main shell but with
 * `?surface=...` in its URL. `main.tsx` decodes it and mounts this instead of
 * the full <App>, so the window shows ONLY the requested surface (today: a
 * plugin iframe). It reuses <StandalonePluginIframe> verbatim — the iframe is
 * always `active` here because the whole OS window IS the visibility (no
 * keep-alive hiding needed at this level).
 *
 * Business state stays consistent with the main window because both talk to
 * the same backend (/api, /ws) — no cross-window state plumbing required.
 */
import type { ReactElement } from 'react';
import type { SurfaceDescriptor } from '../lib/platform';
import { useTranslation } from '@/i18n';
import { usePluginManifest } from '../lib/use-plugin-manifest';
import { StandalonePluginIframe } from './MainArea/StandalonePluginIframe';
import { AgentsMainArea, WorkbenchModeDefault } from './MainArea/WorkbenchMode';
import { ChatPanel } from './ChatPanel/ChatPanel';
import { ConsolePanel } from './MainArea/ConsolePanel';
import { PreviewPanel, EditPanel } from './MainArea/SurfacePanels';
import { Sidebar } from './Sidebar/Sidebar';
import { MainArea } from './MainArea/MainArea';

interface Props {
  surface: SurfaceDescriptor;
}

export function DetachedSurface({ surface }: Props): ReactElement {
  if (surface.kind === 'plugin') {
    return <DetachedPluginSurface surface={surface} />;
  }
  return <DetachedPanelSurface surface={surface} />;
}

/** Built-in panels (agents / files / chat) hosted in their own OS window. All
 *  are fully store-driven (no props), and main.tsx has booted the store +
 *  streams for this window, so they render & stay live like in the main shell.
 *  Wrapped full-bleed since they normally live inside a sized layout slot. */
function DetachedPanelSurface({ surface }: Props): ReactElement {
  const { t } = useTranslation();
  let body: ReactElement;
  switch (surface.id) {
    case 'chat':
      body = <ChatPanel />;
      break;
    case 'agents':
      body = <AgentsMainArea />;
      break;
    case 'files':
      body = <WorkbenchModeDefault showGalleryWhenEmpty={false} />;
      break;
    // DockShell panels popped into their own OS window (design §0.2.2 / #10).
    case 'console':
      body = <ConsolePanel />;
      break;
    case 'workbench':
      body = <Sidebar />;
      break;
    case 'main':
      body = <MainArea />;
      break;
    // Preview viewport panel — renders the game preview iframe in its own window.
    case 'preview':
      body = <PreviewPanel />;
      break;
    // Edit viewport panel — renders the full editor (NOT viewportOnly) in its own
    // window: the editor iframe boots with its own DockManager panels so the OS
    // window is a complete standalone editor experience.
    case 'edit':
      body = <EditPanel />;
      break;
    default:
      return (
        <div style={fillCenter}>
          <span style={{ color: '#888' }}>{t('detachedSurface.unknownPanel', { id: surface.id })}</span>
        </div>
      );
  }
  return (
    <div className="fx-detached-surface fx-detached-panel main-area" style={fill}>
      {body}
    </div>
  );
}

function DetachedPluginSurface({ surface }: Props): ReactElement {
  const { t } = useTranslation();
  const manifest = usePluginManifest(surface.id);

  if (manifest === 'loading') {
    return (
      <div style={fillCenter}>
        <span style={{ color: '#888' }}>{t('detachedSurface.loadingPlugin', { id: surface.id })}</span>
      </div>
    );
  }
  if (!manifest) {
    return (
      <div style={fillCenter}>
        <span style={{ color: '#c44' }}>{t('detachedSurface.pluginNotFound', { id: surface.id })}</span>
      </div>
    );
  }

  return (
    <div className="fx-detached-surface" style={fill}>
      <StandalonePluginIframe plugin={manifest} pane={surface.pane} active />
    </div>
  );
}

const fill: React.CSSProperties = { position: 'fixed', inset: 0 };
const fillCenter: React.CSSProperties = {
  ...fill,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};
