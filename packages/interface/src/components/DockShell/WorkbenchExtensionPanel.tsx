import { lazy, Suspense } from 'react';
import { ExternalLink } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { pickLang } from '../../lib/extension-api';
import { useExtensionManifest } from '../../lib/use-extension-manifest';
import { getWindowManager, type SurfaceDescriptor, type SurfacePane } from '../../lib/platform';
import { useShellStore } from '../../store';
import { usePanelRenderers } from './panelRenderers';
import { WorkbenchRuntimeFrame } from './WorkbenchRuntimeFrame';
import { isWorkbenchHostExtension, useWorkbenchCatalogEntry } from './workbenchRuntime';

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

function LegacyStandalonePanel({
  manifest,
  label,
  pane,
}: {
  manifest: Exclude<ReturnType<typeof useExtensionManifest>, null | 'loading'>;
  label: string;
  pane?: SurfacePane;
}) {
  const { t } = useTranslation();
  const detachSurface = useShellStore((state) => state.detachSurface);
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

function WorkbenchHostPanel({
  extensionId,
  pane,
  onEditorAssetImport,
}: {
  extensionId: string;
  pane?: SurfacePane;
  onEditorAssetImport?: import('./panelRenderers').EditorAssetImportSourceHandler;
}) {
  const { t } = useTranslation();
  const activeGameSlug = useShellStore((state) => state.activeGameSlug);
  const activeGameResolved = useShellStore((state) => state.activeGameResolved);
  const runtime = useWorkbenchCatalogEntry(extensionId, activeGameSlug, activeGameResolved);

  if (runtime.loading) {
    return <div className="wb-dock-loading">{t('wbExtensionDock.loadingWorkbenchHost')}</div>;
  }
  if (runtime.error) {
    return (
      <div className="wb-dock-loading wb-dock-error" role="alert">
        <div>{t('wbExtensionDock.workbenchHostFailed', { error: runtime.error.message })}</div>
        <button type="button" onClick={runtime.retry}>{t('wbExtensionDock.retry')}</button>
      </div>
    );
  }
  if (runtime.descriptor && activeGameSlug) {
    return (
      <div className="wb-dock-panel wb-dock-standalone">
        <WorkbenchRuntimeFrame
          descriptor={runtime.descriptor}
          gameId={activeGameSlug}
          pane={pane}
          onEditorAssetImport={onEditorAssetImport}
        />
      </div>
    );
  }
  return (
    <div className="wb-dock-loading wb-dock-error" role="alert">
      <div>
        {activeGameSlug
          ? t('wbExtensionDock.workbenchExtensionMissing', { extensionId })
          : t('wbExtensionDock.workbenchGameRequired')}
      </div>
      <button type="button" onClick={runtime.retry}>{t('wbExtensionDock.retry')}</button>
    </div>
  );
}

/** Render one Page placement for a Workbench extension. The Page owns panel
 * availability and position; `pane` only selects the extension's content mode. */
export function WorkbenchExtensionPanel({ extensionId, pane }: Props) {
  const { t, i18n } = useTranslation();
  const manifest = useExtensionManifest(extensionId);
  const { workbenchPanels, editor } = usePanelRenderers();

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
    if (!isWorkbenchHostExtension(manifest.id)) {
      return <LegacyStandalonePanel manifest={manifest} label={label} pane={pane} />;
    }
    return (
      <WorkbenchHostPanel
        extensionId={extensionId}
        pane={pane}
        onEditorAssetImport={editor?.importAssetSource}
      />
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
