// A self-contained wrapper that renders ONE workbench plugin as a top-level
// DockShell panel (independent of the Sidebar's plugin rail). Lifecycle:
//   1. Panel mounts → calls addDockedPlugin so Sidebar skips the keep-alive
//      iframe for this plugin (no double-rendering).
//   2. Renders StandalonePluginIframe for standalone plugins, or a minimal info
//      card for non-standalone ones.
//   3. Panel unmounts → removeDockedPlugin so Sidebar can host it again.
import { useEffect, lazy, Suspense } from 'react';
import { ExternalLink } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { usePluginManifest } from '../../lib/use-plugin-manifest';
import { pluginRendersInSidebarLeftPane } from '../MainArea/WorkbenchPluginHost';
import { getWindowManager, type SurfaceDescriptor } from '../../lib/platform';
import { useShellStore } from '../../store';
import { pickLang } from '../../lib/bus-api';
import { usePanelRenderers } from './panelRenderers';

// Lazy-load StandalonePluginIframe so its @forgeax/host-sdk dependency stays
// OUT of DockShell's static import graph. This matters for the editor
// standalone shell (:15290), which renders only <DockShell> and must resolve
// without host-sdk present. The plugin iframe is only needed when a wb:* plugin
// panel is actually opened (studio-only feature), so deferring it is free.
const StandalonePluginIframe = lazy(() =>
  import('../MainArea/StandalonePluginIframe').then((m) => ({ default: m.StandalonePluginIframe })),
);

interface Props {
  pluginId: string;
}

export function WbPluginDockPanel({ pluginId }: Props) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const addDockedPlugin = useShellStore((s) => s.addDockedPlugin);
  const removeDockedPlugin = useShellStore((s) => s.removeDockedPlugin);
  const detachSurface = useShellStore((s) => s.detachSurface);
  const manifest = usePluginManifest(pluginId);
  const { workbenchPanels } = usePanelRenderers();

  useEffect(() => {
    addDockedPlugin(pluginId);
    return () => removeDockedPlugin(pluginId);
  }, [pluginId, addDockedPlugin, removeDockedPlugin]);

  const InlinePanel = workbenchPanels?.[pluginId];
  if (InlinePanel) {
    return (
      <div className="wb-dock-panel wb-dock-inline">
        <InlinePanel />
      </div>
    );
  }

  if (!manifest || manifest === 'loading') {
    return (
      <div className="wb-dock-panel">
        <div className="wb-dock-loading">{t('wbPluginDock.loadingPlugin', { pluginId })}</div>
      </div>
    );
  }

  const label = pickLang(manifest.displayName, locale, manifest.id);
  const desc = pickLang(manifest.description ?? '', locale, '');
  const isStandalone = pluginRendersInSidebarLeftPane(manifest);

  if (isStandalone) {
    const desc2: SurfaceDescriptor = { kind: 'plugin', id: manifest.id, pane: 'left' };
    return (
      <div className="wb-dock-panel wb-dock-standalone">
        {getWindowManager().canDetach() && (
          <button
            type="button"
            className="wb-dock-popout-btn"
            title={t('wbPluginDock.popoutTitle')}
            onClick={() => void detachSurface(desc2, { title: label })}
          >
            <ExternalLink size={12} /> {t('wbPluginDock.popoutLabel')}
          </button>
        )}
        <Suspense fallback={<div className="wb-dock-loading">{t('wbPluginDock.loadingPluginGeneric')}</div>}>
          <StandalonePluginIframe plugin={manifest} pane="left" active />
        </Suspense>
      </div>
    );
  }

  // Non-standalone: show a minimal info card — the actual content lives in
  // MainArea's CenterPluginLayer / WorkbenchMode.
  return (
    <div className="wb-dock-panel wb-dock-placeholder">
      <div className="wb-dock-name">{label}</div>
      {desc && <div className="wb-dock-desc">{desc}</div>}
      <div className="wb-dock-id">{manifest.id}</div>
    </div>
  );
}
