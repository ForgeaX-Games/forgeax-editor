import { lazy, Suspense } from 'react';
import { ExternalLink } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { pickLang } from '../../lib/extension-api';
import { useExtensionManifest } from '../../lib/use-extension-manifest';
import { getWindowManager, type SurfaceDescriptor, type SurfacePane } from '../../lib/platform';
import { useShellStore } from '../../store';
import { usePanelRenderers } from './panelRenderers';

// Keep host-sdk out of standalone DockShell's static import graph. Catalog
// Pages load this runtime only when an iframe-backed placement is mounted.
const StandaloneExtensionIframe = lazy(() =>
  import('../MainArea/StandaloneExtensionIframe').then((module) => ({
    default: module.StandaloneExtensionIframe,
  })),
);

interface Props {
  extensionId: string;
  pane?: SurfacePane;
}

/** Render one Page placement for a Workbench extension. The Page owns panel
 * availability and position; `pane` only selects the extension's content mode. */
export function WorkbenchExtensionPanel({ extensionId, pane }: Props) {
  const { t, i18n } = useTranslation();
  const detachSurface = useShellStore((state) => state.detachSurface);
  const manifest = useExtensionManifest(extensionId);
  const { workbenchPanels } = usePanelRenderers();

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

  const label = pickLang(manifest.displayName, i18n.language, manifest.id);
  if (manifest.entry?.standalone) {
    const descriptor: SurfaceDescriptor = { kind: 'plugin', id: manifest.id, ...(pane ? { pane } : {}) };
    return (
      <div className="wb-dock-panel wb-dock-standalone">
        {getWindowManager().canDetach() && (
          <button
            type="button"
            className="wb-dock-popout-btn"
            title={t('wbExtensionDock.popoutTitle')}
            onClick={() => void detachSurface(descriptor, { title: label })}
          >
            <ExternalLink size={12} /> {t('wbExtensionDock.popoutLabel')}
          </button>
        )}
        <Suspense fallback={<div className="wb-dock-loading">{t('wbExtensionDock.loadingExtensionGeneric')}</div>}>
          <StandaloneExtensionIframe plugin={manifest} pane={pane} active />
        </Suspense>
      </div>
    );
  }

  const description = pickLang(manifest.description ?? '', i18n.language, '');
  return (
    <div className="wb-dock-panel wb-dock-placeholder">
      <div className="wb-dock-name">{label}</div>
      {description && <div className="wb-dock-desc">{description}</div>}
      <div className="wb-dock-id">{manifest.id}</div>
    </div>
  );
}
