import type { ReactElement } from 'react';
import { MoveLeft } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useAppStore } from '../../store';
import type { BusPluginInfo } from '../../lib/bus-api';
import { usePluginManifest } from '../../lib/use-plugin-manifest';
import { WorkbenchAgentPicker } from './WorkbenchAgentPicker';
import { usePanelRenderers } from '../DockShell/panelRenderers';

// MainArea-side workbench plugin host. Standalone-iframe plugins are now owned
// by the keep-alive `CenterPluginLayer` (always-mounted overlay in MainArea) so
// they survive tab/mode switches instead of cold-restarting. This component is
// reduced to the one case the layer does NOT handle: the inline
// `wb-plugin-author` panel, which has no standalone iframe build yet.

/** Returns true if the plugin should be rendered in the central MainArea
 *  (i.e. it declares a standalone iframe entry). Sidebar callers use this
 *  to know when to hand off rendering to the central pane. */
export function pluginRendersInMainArea(pluginInfo?: BusPluginInfo | null): boolean {
  return !!pluginInfo?.entry?.standalone;
}

/** Doc 06 §panes — true when the plugin declares an explicit left pane and
 *  ships a standalone iframe to host it. Sidebar uses this to decide whether
 *  to mount `<StandalonePluginIframe pane="left">` in place of the legacy
 *  BusPluginPlaceholder info card. */
export function pluginRendersInSidebarLeftPane(pluginInfo?: BusPluginInfo | null): boolean {
  return !!(pluginInfo?.entry?.standalone && pluginInfo?.workbench?.panes?.left);
}

/** Inline host for non-iframe workbench panels. WorkbenchMode routes
 *  standalone-iframe plugins to the keep-alive CenterPluginLayer and only calls
 *  this for plugins that have an injected inline panel (see
 *  PanelRenderers.workbenchPanels — studio registers wb-plugin-author; interface
 *  itself names no specific plugin). The manifest fetch just feeds the agent
 *  picker's preferredAgent. */
export function WorkbenchPluginHost(): ReactElement | null {
  const { t } = useTranslation();
  const pluginId = useAppStore((s) => s.workbenchExpandedPluginId);
  const setPluginId = useAppStore((s) => s.setWorkbenchExpandedPluginId);
  const manifest = usePluginManifest(pluginId ?? '');
  const { workbenchPanels } = usePanelRenderers();

  if (!pluginId) return null;

  const back = (
    <button className="wb-plugin-back" onClick={() => setPluginId(null)} title={t('centerPlugin.backToTileGridTitle')}>
      <MoveLeft size={12} /><span>{t('centerPlugin.backToWorkbench')}</span>
    </button>
  );

  const picker = (
    <WorkbenchAgentPicker
      preferredAgentPluginId={
        manifest && manifest !== 'loading' ? manifest.workbench?.preferredAgent : undefined
      }
    />
  );

  // Standalone-iframe plugins are owned by CenterPluginLayer (keep-alive).
  if (manifest && manifest !== 'loading' && manifest.entry?.standalone) return null;

  // Inline (non-iframe) panel injected by the host. Studio registers
  // wb-plugin-author here; standalone registers nothing → this map is empty and
  // we fall through to the placeholder branch below. interface holds no plugin
  // id — it renders whatever the host injected for this expanded plugin.
  const InlinePanel = workbenchPanels?.[pluginId];
  if (InlinePanel) {
    return (
      <div className="wb-plugin-host">
        <div className="wb-plugin-host-bar">{back}{picker}</div>
        <div className="wb-plugin-host-body" style={{ display: 'flex', flexDirection: 'column' }}>
          <InlinePanel />
        </div>
      </div>
    );
  }

  // Manifest still resolving, or a non-standalone non-author plugin — the
  // CenterPluginLayer overlay renders the loading / "缺少入口" status instead.
  return null;
}
