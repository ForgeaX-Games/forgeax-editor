import { useEffect, useRef, useState } from 'react';
import { mountUi, type UiAsset } from '@forgeax/engine-ui';
import { resolveGamePath } from '@forgeax/editor-core';
import { useTranslation } from '@forgeax/editor-core/i18n';
import { realPayload } from './hooks';
import type { CBAsset } from './types';

interface Props {
  asset: CBAsset;
  gameSlug: string;
}

function sourceDiskPath(sourcePath: string, gameSlug: string): string {
  const normalized = sourcePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const marker = `${gameSlug}/`;
  const markerIndex = normalized.indexOf(marker);
  return resolveGamePath(markerIndex >= 0 ? normalized.slice(markerIndex + marker.length) : normalized);
}

function cssSourcePath(sourcePath: string): string {
  return sourcePath.replace(/\.ui\.html$/i, '.ui.css');
}

/** Preview the same UiAsset payload the runtime mounts, inside a bounded CB viewport. */
export function CBUiAssetPreview({ asset, gameSlug }: Props) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.replaceChildren();
    setError(null);

    let cancelled = false;
    const mount = (payload: { html: string; css: string }) => {
      if (cancelled) return;
      const mounted = mountUi(
        { guid: asset.guid, html: payload.html, css: payload.css } satisfies UiAsset,
        { root, layer: 0 },
      );
      if (!mounted.ok) {
        setError(mounted.error.code);
        return;
      }
      // Some UI assets are authored hidden until game code opens them (for
      // example the settings dialog). A Content Browser asset preview has no
      // gameplay controller, so reveal those authored regions for inspection;
      // this changes only the preview DOM, never the asset payload on disk.
      mounted.value.host.shadowRoot?.querySelectorAll<HTMLElement>('[hidden]').forEach((element) => {
        element.hidden = false;
      });
      cleanup = mounted.value.dispose;
    };
    let cleanup: (() => void) | undefined;
    const payload = realPayload(asset.guid, asset.payload);
    if (typeof payload.html === 'string' && typeof payload.css === 'string') {
      mount({ html: payload.html, css: payload.css });
    } else if (asset.sourcePath) {
      const source = sourceDiskPath(asset.sourcePath, gameSlug);
      const css = sourceDiskPath(cssSourcePath(asset.sourcePath), gameSlug);
      void Promise.all([
        fetch(`/api/files/raw?path=${encodeURIComponent(source)}`, { cache: 'no-store' }).then(response => response.ok ? response.text() : Promise.reject(new Error(`HTTP ${response.status}`))),
        fetch(`/api/files/raw?path=${encodeURIComponent(css)}`, { cache: 'no-store' }).then(response => response.ok ? response.text() : Promise.reject(new Error(`HTTP ${response.status}`))),
      ]).then(([html, cssText]) => mount({ html, css: cssText })).catch(() => {
        if (!cancelled) setError(t('editor.contentBrowser.preview.uiPayloadUnavailable'));
      });
    } else {
      setError(t('editor.contentBrowser.preview.uiPayloadUnavailable'));
    }
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [asset.guid, asset.kind, asset.packPath, asset.sourcePath, gameSlug, t]);

  return (
    <div className="cb-preview-ui-viewport" ref={rootRef} aria-label={t('editor.contentBrowser.preview.uiPreview')}>
      {error && <div className="cb-preview-note">{error}</div>}
    </div>
  );
}
