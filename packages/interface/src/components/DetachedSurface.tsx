/**
 * DetachedSurface — the root rendered inside a detached OS window.
 *
 * A detached window loads the SAME bundle as the main shell but with
 * `?surface=...` in its URL. `main.tsx` decodes it and mounts this instead of
 * the full <App>, so the window shows ONLY the requested surface (today: a
 * plugin iframe). It reuses <StandaloneExtensionIframe> verbatim — the iframe is
 * always `active` here because the whole OS window IS the visibility (no
 * keep-alive hiding needed at this level).
 *
 * Business state stays consistent with the main window because both talk to
 * the same backend (/api, /ws) — no cross-window state plumbing required.
 */
import type { ReactElement } from 'react';
import type { SurfaceDescriptor } from '../lib/platform';
import { useTranslation } from '@/i18n';
import { useExtensionManifest } from '../lib/use-extension-manifest';
import { StandaloneExtensionIframe } from './MainArea/StandaloneExtensionIframe';
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
    return <DetachedExtensionSurface surface={surface} />;
  }
  return <DetachedPanelSurface surface={surface} />;
}

/** Built-in panels (agents / files / chat) hosted in their own OS window. All
 *  are fully store-driven (no props), and main.tsx has booted the store +
 *  streams for this window, so they render & stay live like in the main shell.
 *  Wrapped full-bleed since they normally live inside a sized layout slot. */
function DetachedPanelSurface({ surface }: Props): ReactElement {
  const { t } = useTranslation();
  const renderers = usePanelRenderers();
  const chatDescriptor = renderers.panels?.chat;
  const SceneEditor = renderers.surfaces?.SceneEditor;
  const AgentsBrowser = renderers.detached?.AgentsBrowser;
  const FilesBrowser = renderers.detached?.FilesBrowser;
  let body: ReactElement;
  switch (surface.id) {
    case 'chat':
      // chat is a 前L2 @forgeax/chat app injected via panels['chat'] (R4); a
      // detached chat window has no keep-alive layer so render it directly.
      body = (
        <>
          {chatDescriptor ? (
            <div data-fx-slot="DockPanel:chat" style={{ display: 'contents' }}>{chatDescriptor.render()}</div>
          ) : (
            <NoEditorBody />
          )}
        </>
      );
      break;
    case 'agents':
      // 前L2 @forgeax/ai-workbench via detached.AgentsBrowser (R4): agents browser variant.
      body = (
        <>
          {AgentsBrowser ? (
            <div data-fx-slot="AgentsBrowser" style={{ display: 'contents' }}><AgentsBrowser /></div>
          ) : (
            <NoEditorBody />
          )}
        </>
      );
      break;
    case 'files':
      // 前L2 @forgeax/ai-workbench via detached.FilesBrowser (R4): file workbench variant.
      body = (
        <>
          {FilesBrowser ? (
            <div data-fx-slot="FilesBrowser" style={{ display: 'contents' }}><FilesBrowser /></div>
          ) : (
            <NoEditorBody />
          )}
        </>
      );
      break;
    // DockShell panels popped into their own OS window (design §0.2.2 / #10).
    case 'console':
      body = <ConsolePanel />;
      break;
    case 'tools':
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
    case 'edit': // legacy backward compat
    case 'preview': // legacy backward compat
      body = (
        <div className="surface-region">
          <FatalBanner source="edit" />
          {SceneEditor ? (
            <div data-fx-slot="SceneEditor" style={{ display: 'contents' }}><SceneEditor viewportOnly={false} /></div>
          ) : (
            <NoEditorBody />
          )}
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

function DetachedExtensionSurface({ surface }: Props): ReactElement {
  const { t } = useTranslation();
  const manifest = useExtensionManifest(surface.id);

  if (manifest === 'loading') {
    return (
      <div style={fillCenter}>
        <span style={{ color: '#888' }}>{t('detachedSurface.loadingExtension', { id: surface.id })}</span>
      </div>
    );
  }
  if (!manifest) {
    return (
      <div style={fillCenter}>
        <span style={{ color: '#c44' }}>{t('detachedSurface.extensionNotFound', { id: surface.id })}</span>
      </div>
    );
  }

  return (
    <div className="fx-detached-surface" style={fill}>
      <StandaloneExtensionIframe plugin={manifest} pane={surface.pane} active />
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
