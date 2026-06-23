// A self-contained wrapper that renders ONE workbench plugin as a top-level
// DockShell panel (independent of the Sidebar's plugin rail). Lifecycle:
//   1. Panel mounts → calls addDockedPlugin so Sidebar skips the keep-alive
//      iframe for this plugin (no double-rendering).
//   2. Renders StandalonePluginIframe for standalone plugins, or a minimal info
//      card for non-standalone ones.
//   3. Panel unmounts → removeDockedPlugin so Sidebar can host it again.
import { useEffect, lazy, Suspense } from 'react';
import { ExternalLink } from 'lucide-react';
import { usePluginManifest } from '../../lib/use-plugin-manifest';
import { pluginRendersInSidebarLeftPane } from '../MainArea/WorkbenchPluginHost';
import { getWindowManager, type SurfaceDescriptor } from '../../lib/platform';
import { useAppStore } from '../../store';
import { pickLang } from '../../lib/bus-api';

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
  const addDockedPlugin = useAppStore((s) => s.addDockedPlugin);
  const removeDockedPlugin = useAppStore((s) => s.removeDockedPlugin);
  const detachSurface = useAppStore((s) => s.detachSurface);
  const manifest = usePluginManifest(pluginId);

  useEffect(() => {
    addDockedPlugin(pluginId);
    return () => removeDockedPlugin(pluginId);
  }, [pluginId, addDockedPlugin, removeDockedPlugin]);

  if (!manifest || manifest === 'loading') {
    return (
      <div className="wb-dock-panel">
        <div className="wb-dock-loading">正在加载 {pluginId}…</div>
      </div>
    );
  }

  const label = pickLang(manifest.displayName, 'zh', manifest.id);
  const desc = pickLang(manifest.description ?? '', 'zh', '');
  const isStandalone = pluginRendersInSidebarLeftPane(manifest);

  if (isStandalone) {
    const desc2: SurfaceDescriptor = { kind: 'plugin', id: manifest.id, pane: 'left' };
    return (
      <div className="wb-dock-panel wb-dock-standalone">
        {getWindowManager().canDetach() && (
          <button
            type="button"
            className="wb-dock-popout-btn"
            title="弹出为独立 OS 窗口"
            onClick={() => void detachSurface(desc2, { title: label })}
          >
            <ExternalLink size={12} /> 独立窗口
          </button>
        )}
        <Suspense fallback={<div className="wb-dock-loading">正在加载插件…</div>}>
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
