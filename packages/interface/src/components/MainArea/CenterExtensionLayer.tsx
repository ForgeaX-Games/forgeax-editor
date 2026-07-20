import { useRef } from 'react';
import type { ReactElement } from 'react';
import { MoveLeft, ExternalLink, PictureInPicture2 } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useShellStore } from '../../store';
import { useExtensionManifest, manifestMatchesId } from '../../lib/use-extension-manifest';
import { pickLang, type ExtensionInfo } from '../../lib/extension-api';
import { getWindowManager, surfaceKey, type SurfaceDescriptor } from '../../lib/platform';
import { KeepAliveExtensionIframes } from './KeepAliveExtensionIframes';
import { usePanelRenderers } from '../DockShell/panelRenderers';

/**
 * Always-mounted overlay that owns the *center* (MainArea) standalone-plugin
 * experience with keep-alive (Plan A).
 *
 * Why an always-mounted overlay rather than rendering inside WorkbenchMode:
 * WorkbenchMode (and the whole MainArea conditional tree) unmounts on every
 * mode / tab switch. If the plugin iframe lived there it would be destroyed and
 * cold-restarted on each switch. This layer lives directly under `.main-area`
 * (which never unmounts), so the iframes it owns survive preview↔workbench and
 * tab switches; we only toggle which one is `active` (visible) — see
 * KeepAliveExtensionIframes.
 *
 * The inline wb-plugin-author panel (no standalone iframe build yet) is NOT
 * handled here — WorkbenchMode still routes it to WorkbenchExtensionHost.
 */
export function CenterExtensionLayer(): ReactElement {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const CornerAgentPicker = usePanelRenderers().slots?.CornerAgentPicker;
  const mode = useShellStore((s) => s.mode);
  const expandedExtensionId = useShellStore((s) => s.workbenchExpandedExtensionId);
  const setExpandedExtensionId = useShellStore((s) => s.setWorkbenchExpandedExtensionId);
  const floatingSurfaces = useShellStore((s) => s.floatingSurfaces);
  const detachSurface = useShellStore((s) => s.detachSurface);
  const redockSurface = useShellStore((s) => s.redockSurface);
  const live = useExtensionManifest(expandedExtensionId ?? '');

  // Per-plugin manifest cache. `useExtensionManifest` flips back to 'loading' on
  // every expandedExtensionId change (its effect re-fetches), which would null out
  // `activeExtension` and flash the "正在加载插件…" overlay even when switching to a
  // plugin whose iframe is already kept alive. Caching the last resolved
  // manifest per id lets a re-visit resolve synchronously → no loading flash,
  // no hide/show flicker. New (never-seen) plugins still show loading once.
  const manifestCacheRef = useRef<Map<string, ExtensionInfo>>(new Map());
  // `live` may briefly be the PREVIOUS plugin's manifest on the first render
  // after a switch — only trust it when it matches the current expanded id (by
  // either manifest id or workbench-id alias, since callers open by both).
  const liveForThis = live && live !== 'loading' && expandedExtensionId && manifestMatchesId(live, expandedExtensionId) ? live : null;
  // Key the cache by the REQUESTED id (expandedExtensionId), not live.id: a caller
  // that opens by the workbench-id alias must get a cache hit on re-visit, else
  // the loading overlay flashes every time.
  if (liveForThis && expandedExtensionId) {
    manifestCacheRef.current.set(expandedExtensionId, liveForThis);
  }
  const cached = expandedExtensionId ? manifestCacheRef.current.get(expandedExtensionId) ?? null : null;

  // Prefer the cache (always correct for this id, resolves synchronously on a
  // re-visit so there's no loading flash); fall back to a freshly-resolved
  // matching manifest on the genuine first open.
  const resolved = cached ?? liveForThis;
  const isStandalone = !!resolved?.entry?.standalone;
  const activeExtension = mode === 'ai' && expandedExtensionId && isStandalone ? resolved : null;

  // Only show loading when we have NOTHING resolved yet (genuine first open),
  // never on a cached re-visit.
  const showLoading = mode === 'ai' && !!expandedExtensionId && live === 'loading' && !resolved;
  const showError =
    mode === 'ai' && !!expandedExtensionId && live !== 'loading' && !isStandalone
    // wb-plugin-author renders inline via WorkbenchExtensionHost, not here.
    && resolved !== null;
  const showUnavailable =
    mode === 'ai' && !!expandedExtensionId && live === null && !resolved;

  const layerActive = !!activeExtension || showLoading || showError || showUnavailable;

  // Windowing — the center surface descriptor for the active plugin.
  const canDetach = getWindowManager().canDetach();
  const centerDescriptor: SurfaceDescriptor | null = activeExtension
    ? { kind: 'plugin', id: activeExtension.id, pane: 'center' }
    : null;
  const isCenterFloating = centerDescriptor
    ? !!floatingSurfaces[surfaceKey(centerDescriptor)]
    : false;

  const back = (
    <button
      className="wb-plugin-back"
      onClick={() => setExpandedExtensionId(null)}
      title={t('centerExtension.backToTileGridTitle')}
    >
      <MoveLeft size={12} /><span>{t('centerExtension.backToWorkbench')}</span>
    </button>
  );

  // 弹出 / 收回 — only meaningful inside the Tauri shell (canDetach). In the
  // browser form the button is hidden entirely.
  const windowToggle =
    canDetach && centerDescriptor ? (
      isCenterFloating ? (
        <button
          className="wb-plugin-window-toggle"
          onClick={() => void redockSurface(centerDescriptor)}
          title={t('centerExtension.redockTitle')}
        >
          <PictureInPicture2 size={12} /><span>{t('centerExtension.redock')}</span>
        </button>
      ) : (
        <button
          className="wb-plugin-window-toggle"
          onClick={() =>
            void detachSurface(centerDescriptor, {
              title: activeExtension ? pickLang(activeExtension.displayName, locale, activeExtension.id) : undefined,
            })
          }
          title={t('centerExtension.detachTitle')}
        >
          <ExternalLink size={12} /><span>{t('centerExtension.detach')}</span>
        </button>
      )
    ) : null;

  return (
    <div
      className={`fx-center-plugin-layer${layerActive ? ' active' : ''}`}
      // Dormant overlay: invisible & click-through so PreviewMode / WorkbenchMode
      // underneath are fully usable, while the kept-alive iframes inside stay
      // mounted (and paused via the visibility signal).
      style={layerActive ? undefined : { visibility: 'hidden', pointerEvents: 'none' }}
      aria-hidden={layerActive ? undefined : true}
    >
      {layerActive && (
        <div className="wb-plugin-host-bar">
          {back}
          {CornerAgentPicker
            ? <div data-fx-slot="CornerAgentPicker" style={{ display: 'contents' }}>
                <CornerAgentPicker preferredAgentExtensionId={activeExtension?.workbench?.preferredAgent} />
              </div>
            : null}
          {windowToggle}
        </div>
      )}
      <div className="fx-center-plugin-body">
        <KeepAliveExtensionIframes
          pane="center"
          activeExtension={activeExtension}
          floatingKeys={floatingSurfaces}
        />
        {isCenterFloating && activeExtension && (
          <div className="fx-center-plugin-status fx-surface-floating" style={{ padding: 20, color: '#888' }}>
            <p>
              {t('centerExtension.openedInWindowPrefix')}<code>{pickLang(activeExtension.displayName, locale, activeExtension.id)}</code>{t('centerExtension.openedInWindowSuffix')}
            </p>
            <button className="wb-plugin-window-toggle" onClick={() => void redockSurface(centerDescriptor!)}>
              <PictureInPicture2 size={12} /><span>{t('centerExtension.redock')}</span>
            </button>
          </div>
        )}
        {showLoading && (
          <div className="fx-center-plugin-status" style={{ padding: 20, color: '#888' }}>
            {t('centerExtension.loadingExtensionPrefix')}<code>{expandedExtensionId}</code>{t('centerExtension.loadingExtensionSuffix')}
          </div>
        )}
        {showError && (
          <div className="fx-center-plugin-status" style={{ padding: 20, color: '#888' }}>
            {t('centerExtension.missingStandalonePrefix')}<code>{expandedExtensionId}</code>{t('centerExtension.missingStandaloneMid')}<code>entry.standalone</code>{t('centerExtension.missingStandaloneSuffix')}
          </div>
        )}
        {showUnavailable && (
          <div className="fx-center-plugin-status" style={{ padding: 20, color: '#c44' }}>
            {t('centerExtension.extensionUnavailablePrefix')}<code>{expandedExtensionId}</code>{t('centerExtension.extensionUnavailableSuffix')}
          </div>
        )}
      </div>
    </div>
  );
}
