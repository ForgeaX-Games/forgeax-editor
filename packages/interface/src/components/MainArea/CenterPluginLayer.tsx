import { useRef } from 'react';
import type { ReactElement } from 'react';
import { MoveLeft, ExternalLink, PictureInPicture2 } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useAppStore } from '../../store';
import { usePluginManifest } from '../../lib/use-plugin-manifest';
import { pickLang, type BusPluginInfo } from '../../lib/bus-api';
import { getWindowManager, surfaceKey, type SurfaceDescriptor } from '../../lib/platform';
import { KeepAlivePluginIframes } from './KeepAlivePluginIframes';
import { WorkbenchAgentPicker } from './WorkbenchAgentPicker';

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
 * KeepAlivePluginIframes.
 *
 * The inline wb-plugin-author panel (no standalone iframe build yet) is NOT
 * handled here — WorkbenchMode still routes it to WorkbenchPluginHost.
 */
export function CenterPluginLayer(): ReactElement {
  const { t } = useTranslation();
  const mode = useAppStore((s) => s.mode);
  const expandedPluginId = useAppStore((s) => s.workbenchExpandedPluginId);
  const setExpandedPluginId = useAppStore((s) => s.setWorkbenchExpandedPluginId);
  const floatingSurfaces = useAppStore((s) => s.floatingSurfaces);
  const detachSurface = useAppStore((s) => s.detachSurface);
  const redockSurface = useAppStore((s) => s.redockSurface);
  const live = usePluginManifest(expandedPluginId ?? '');

  // Per-plugin manifest cache. `usePluginManifest` flips back to 'loading' on
  // every expandedPluginId change (its effect re-fetches), which would null out
  // `activePlugin` and flash the "正在加载插件…" overlay even when switching to a
  // plugin whose iframe is already kept alive. Caching the last resolved
  // manifest per id lets a re-visit resolve synchronously → no loading flash,
  // no hide/show flicker. New (never-seen) plugins still show loading once.
  const manifestCacheRef = useRef<Map<string, BusPluginInfo>>(new Map());
  if (live && live !== 'loading' && live.id) {
    manifestCacheRef.current.set(live.id, live);
  }
  const cached = expandedPluginId ? manifestCacheRef.current.get(expandedPluginId) ?? null : null;
  // `live` may briefly be the PREVIOUS plugin's manifest on the first render
  // after a switch — only trust it when its id matches the current expanded id.
  const liveForThis = live && live !== 'loading' && live.id === expandedPluginId ? live : null;

  // Prefer the cache (always correct for this id, resolves synchronously on a
  // re-visit so there's no loading flash); fall back to a freshly-resolved
  // matching manifest on the genuine first open.
  const resolved = cached ?? liveForThis;
  const isStandalone = !!resolved?.entry?.standalone;
  const activePlugin = mode === 'workbench' && expandedPluginId && isStandalone ? resolved : null;

  // Only show loading when we have NOTHING resolved yet (genuine first open),
  // never on a cached re-visit.
  const showLoading = mode === 'workbench' && !!expandedPluginId && live === 'loading' && !resolved;
  const showError =
    mode === 'workbench' && !!expandedPluginId && live !== 'loading' && !isStandalone
    // wb-plugin-author renders inline via WorkbenchPluginHost, not here.
    && resolved !== null;

  const layerActive = !!activePlugin || showLoading || showError;

  // Windowing — the center surface descriptor for the active plugin.
  const canDetach = getWindowManager().canDetach();
  const centerDescriptor: SurfaceDescriptor | null = activePlugin
    ? { kind: 'plugin', id: activePlugin.id, pane: 'center' }
    : null;
  const isCenterFloating = centerDescriptor
    ? !!floatingSurfaces[surfaceKey(centerDescriptor)]
    : false;

  const back = (
    <button
      className="wb-plugin-back"
      onClick={() => setExpandedPluginId(null)}
      title={t('centerPlugin.backToTileGridTitle')}
    >
      <MoveLeft size={12} /><span>{t('centerPlugin.backToWorkbench')}</span>
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
          title={t('centerPlugin.redockTitle')}
        >
          <PictureInPicture2 size={12} /><span>{t('centerPlugin.redock')}</span>
        </button>
      ) : (
        <button
          className="wb-plugin-window-toggle"
          onClick={() =>
            void detachSurface(centerDescriptor, {
              title: activePlugin ? pickLang(activePlugin.displayName, 'zh', activePlugin.id) : undefined,
            })
          }
          title={t('centerPlugin.detachTitle')}
        >
          <ExternalLink size={12} /><span>{t('centerPlugin.detach')}</span>
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
          <WorkbenchAgentPicker preferredAgentPluginId={activePlugin?.workbench?.preferredAgent} />
          {windowToggle}
        </div>
      )}
      <div className="fx-center-plugin-body">
        <KeepAlivePluginIframes
          pane="center"
          activePlugin={activePlugin}
          floatingKeys={floatingSurfaces}
        />
        {isCenterFloating && activePlugin && (
          <div className="fx-center-plugin-status fx-surface-floating" style={{ padding: 20, color: '#888' }}>
            <p>
              {t('centerPlugin.openedInWindowPrefix')}<code>{pickLang(activePlugin.displayName, 'zh', activePlugin.id)}</code>{t('centerPlugin.openedInWindowSuffix')}
            </p>
            <button className="wb-plugin-window-toggle" onClick={() => void redockSurface(centerDescriptor!)}>
              <PictureInPicture2 size={12} /><span>{t('centerPlugin.redock')}</span>
            </button>
          </div>
        )}
        {showLoading && (
          <div className="fx-center-plugin-status" style={{ padding: 20, color: '#888' }}>
            {t('centerPlugin.loadingPluginPrefix')}<code>{expandedPluginId}</code>{t('centerPlugin.loadingPluginSuffix')}
          </div>
        )}
        {showError && (
          <div className="fx-center-plugin-status" style={{ padding: 20, color: '#888' }}>
            {t('centerPlugin.missingStandalonePrefix')}<code>{expandedPluginId}</code>{t('centerPlugin.missingStandaloneMid')}<code>entry.standalone</code>{t('centerPlugin.missingStandaloneSuffix')}
          </div>
        )}
      </div>
    </div>
  );
}
