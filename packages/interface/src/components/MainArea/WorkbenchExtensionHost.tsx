import type { ReactElement } from 'react';
import { MoveLeft } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useShellStore } from '../../store';
import type { ExtensionInfo } from '../../lib/extension-api';
import { useExtensionManifest } from '../../lib/use-extension-manifest';
import { usePanelRenderers } from '../DockShell/panelRenderers';

// MainArea-side workbench plugin host. Standalone-iframe plugins are now owned
// by the keep-alive `CenterExtensionLayer` (always-mounted overlay in MainArea) so
// they survive tab/mode switches instead of cold-restarting. This component is
// reduced to the one case the layer does NOT handle: the inline
// `wb-plugin-author` panel, which has no standalone iframe build yet.

/** Returns true if the plugin should be rendered in the central MainArea
 *  (i.e. it declares a standalone iframe entry). Sidebar callers use this
 *  to know when to hand off rendering to the central pane. */
export function extensionRendersInMainArea(extensionInfo?: ExtensionInfo | null): boolean {
  return !!extensionInfo?.entry?.standalone;
}

/** Doc 06 §panes — true when the plugin declares an explicit left pane and
 *  ships a standalone iframe to host it. Sidebar uses this to decide whether
 *  to mount `<StandaloneExtensionIframe pane="left">` in place of the legacy
 *  ExtensionPlaceholder info card. */
export function extensionRendersInSidebarLeftPane(extensionInfo?: ExtensionInfo | null): boolean {
  return !!(extensionInfo?.entry?.standalone && extensionInfo?.workbench?.panes?.left);
}

/** Inline host for non-iframe workbench panels. WorkbenchMode routes
 *  standalone-iframe plugins to the keep-alive CenterExtensionLayer and only calls
 *  this for plugins that have an injected inline panel (see
 *  PanelRenderers.workbenchPanels — studio registers wb-plugin-author; interface
 *  itself names no specific plugin). The manifest fetch just feeds the agent
 *  picker's preferredAgent. */
export function WorkbenchExtensionHost(): ReactElement | null {
  const { t } = useTranslation();
  const extensionId = useShellStore((s) => s.workbenchExpandedExtensionId);
  const setExtensionId = useShellStore((s) => s.setWorkbenchExpandedExtensionId);
  const manifest = useExtensionManifest(extensionId ?? '');
  const { workbenchPanels, slots } = usePanelRenderers();
  const CornerAgentPicker = slots?.CornerAgentPicker;

  if (!extensionId) return null;

  const back = (
    <button className="wb-plugin-back" onClick={() => setExtensionId(null)} title={t('centerExtension.backToTileGridTitle')}>
      <MoveLeft size={12} /><span>{t('centerExtension.backToWorkbench')}</span>
    </button>
  );

  const preferredAgentExtensionId = manifest && manifest !== 'loading' ? manifest.workbench?.preferredAgent : undefined;

  // Standalone-iframe plugins are owned by CenterExtensionLayer (keep-alive).
  if (manifest && manifest !== 'loading' && manifest.entry?.standalone) return null;

  // Inline (non-iframe) panel injected by the host. Studio registers
  // wb-plugin-author here; standalone registers nothing → this map is empty and
  // we fall through to the placeholder branch below. interface holds no plugin
  // id — it renders whatever the host injected for this expanded plugin.
  const InlinePanel = workbenchPanels?.[extensionId];
  if (InlinePanel) {
    return (
      <div className="wb-plugin-host">
        <div className="wb-plugin-host-bar">
          {back}
          {CornerAgentPicker && (
            <div data-fx-slot="CornerAgentPicker" style={{ display: 'contents' }}>
              <CornerAgentPicker preferredAgentExtensionId={preferredAgentExtensionId} />
            </div>
          )}
        </div>
        <div className="wb-plugin-host-body" style={{ display: 'flex', flexDirection: 'column' }}>
          <div data-fx-slot={`workbenchPanels:${extensionId}`} style={{ display: 'contents' }}>
            <InlinePanel />
          </div>
        </div>
      </div>
    );
  }

  // Manifest still resolving, or a non-standalone non-author plugin — the
  // CenterExtensionLayer overlay renders the loading / "缺少入口" status instead.
  return null;
}
