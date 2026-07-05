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
import { ConsolePanel } from './MainArea/ConsolePanel';
import { Sidebar } from './Sidebar/Sidebar';
import { MainArea } from './MainArea/MainArea';
import { usePanelRenderers } from './DockShell/panelRenderers';
import { FatalBanner } from './StatusBar/FatalBanner';

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
  const { renderPreview, renderEdit, renderChat, renderWorkbench } = usePanelRenderers();
  let body: ReactElement;
  switch (surface.id) {
    case 'chat':
      // chat is a 前L2 @forgeax/chat app injected via renderChat (R4); a
      // detached chat window has no keep-alive layer so render it directly.
      body = <>{renderChat ? renderChat() : <NoEditorBody />}</>;
      break;
    case 'agents':
      // 前L2 @forgeax/workbench via renderWorkbench (R4): agents browser variant.
      body = <>{renderWorkbench ? renderWorkbench('agents') : <NoEditorBody />}</>;
      break;
    case 'files':
      // 前L2 @forgeax/workbench via renderWorkbench (R4): file workbench variant.
      body = <>{renderWorkbench ? renderWorkbench('files') : <NoEditorBody />}</>;
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
    // Viewport panel — renders the combined edit+preview surface in its own window.
    // Detached windows have NO keep-alive layer (the whole OS window IS the
    // visibility), so render the real surface directly via PanelRenderers — not the
    // in-shell <SurfaceAnchor> placeholder, which would leave the window empty.
    // 2026-06-30: 'preview'/'edit' merged into single 'viewport' panel.
    case 'edit':
    case 'edit': // legacy backward compat
    case 'preview': // legacy backward compat
      body = (
        <div className="surface-region">
          <FatalBanner source="edit" />
          {renderEdit ? renderEdit({ viewportOnly: false }) : <NoEditorBody />}
        </div>
      );
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

function NoEditorBody(): ReactElement {
  return (
    <div className="surface-placeholder">
      <div className="surface-placeholder-title">No editor configured</div>
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
