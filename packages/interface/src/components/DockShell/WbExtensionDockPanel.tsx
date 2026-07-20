// A self-contained wrapper that renders ONE workbench plugin as a top-level
// DockShell panel (independent of the Sidebar's plugin rail). Lifecycle:
//   1. Panel mounts → calls addDockedExtension so Sidebar skips the keep-alive
//      iframe for this plugin (no double-rendering).
//   2. Renders StandaloneExtensionIframe for standalone plugins, or a minimal info
//      card for non-standalone ones.
//   3. Panel unmounts → removeDockedExtension so Sidebar can host it again.
import { useEffect, lazy, Suspense } from 'react';
import { ExternalLink } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useExtensionManifest } from '../../lib/use-extension-manifest';
import { extensionRendersInSidebarLeftPane } from '../MainArea/WorkbenchExtensionHost';
import { getWindowManager, type SurfaceDescriptor } from '../../lib/platform';
import { useShellStore } from '../../store';
import { pickLang } from '../../lib/extension-api';
import { usePanelRenderers } from './panelRenderers';

// Lazy-load StandaloneExtensionIframe so its @forgeax/host-sdk dependency stays
// OUT of DockShell's static import graph. This matters for the editor
// standalone shell (:15290), which renders only <DockShell> and must resolve
// without host-sdk present. The plugin iframe is only needed when a wb:* plugin
// panel is actually opened (studio-only feature), so deferring it is free.
const StandaloneExtensionIframe = lazy(() =>
  import('../MainArea/StandaloneExtensionIframe').then((m) => ({ default: m.StandaloneExtensionIframe })),
);

interface Props {
  extensionId: string;
}

export function WbExtensionDockPanel({ extensionId }: Props) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const addDockedExtension = useShellStore((s) => s.addDockedExtension);
  const removeDockedExtension = useShellStore((s) => s.removeDockedExtension);
  const detachSurface = useShellStore((s) => s.detachSurface);
  const manifest = useExtensionManifest(extensionId);
  const { workbenchPanels } = usePanelRenderers();

  useEffect(() => {
    addDockedExtension(extensionId);
    return () => removeDockedExtension(extensionId);
  }, [extensionId, addDockedExtension, removeDockedExtension]);

  const InlinePanel = workbenchPanels?.[extensionId];
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
        <div className="wb-dock-loading">{t('wbExtensionDock.loadingExtension', { extensionId })}</div>
      </div>
    );
  }

  const label = pickLang(manifest.displayName, locale, manifest.id);
  const desc = pickLang(manifest.description ?? '', locale, '');
  const isStandalone = extensionRendersInSidebarLeftPane(manifest);

  if (isStandalone) {
    const desc2: SurfaceDescriptor = { kind: 'plugin', id: manifest.id, pane: 'left' };
    return (
      <div className="wb-dock-panel wb-dock-standalone">
        {getWindowManager().canDetach() && (
          <button
            type="button"
            className="wb-dock-popout-btn"
            title={t('wbExtensionDock.popoutTitle')}
            onClick={() => void detachSurface(desc2, { title: label })}
          >
            <ExternalLink size={12} /> {t('wbExtensionDock.popoutLabel')}
          </button>
        )}
        <Suspense fallback={<div className="wb-dock-loading">{t('wbExtensionDock.loadingExtensionGeneric')}</div>}>
          <StandaloneExtensionIframe plugin={manifest} pane="left" active />
        </Suspense>
      </div>
    );
  }

  // Non-standalone: show a minimal info card — the actual content lives in
  // MainArea's CenterExtensionLayer / WorkbenchMode.
  return (
    <div className="wb-dock-panel wb-dock-placeholder">
      <div className="wb-dock-name">{label}</div>
      {desc && <div className="wb-dock-desc">{desc}</div>}
      <div className="wb-dock-id">{manifest.id}</div>
    </div>
  );
}
