// CBFontPreview — renders a real font preview for a selected .ttf/.otf/.woff
// file. The bytes are loaded via the FontFace API (from /api/files/raw) and a
// short sample of text is rendered in that face. This replaces the old path
// that fetched the font as UTF-8 text and dumped multi-megabyte garbage into a
// <pre>, which froze the main thread.

import { useEffect, useId, useState } from 'react';
import { useTranslation } from '@forgeax/editor-core/i18n';

interface Props {
  rawUrl: string;
  name: string;
}

export function CBFontPreview({ rawUrl, name }: Props) {
  const { t } = useTranslation();
  // A unique, CSS-ident-safe family name per component instance so multiple
  // previews (or re-selections) never collide in document.fonts.
  const family = `cb-font-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    setStatus('loading');
    if (typeof FontFace === 'undefined' || !document.fonts) {
      setStatus('error');
      return;
    }
    let cancelled = false;
    const fontFace = new FontFace(family, `url("${rawUrl}")`);
    fontFace
      .load()
      .then((loaded) => {
        if (cancelled) return;
        document.fonts.add(loaded);
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => {
      cancelled = true;
      try {
        document.fonts.delete(fontFace);
      } catch {
        // deleting a face that never got added is a no-op we don't care about
      }
    };
  }, [rawUrl, family]);

  if (status === 'error') {
    return <div className="cb-preview-note">{t('editor.contentBrowser.preview.fontUnavailable')}</div>;
  }
  if (status === 'loading') {
    return <div className="cb-preview-note">{t('editor.contentBrowser.preview.fontLoading')}</div>;
  }

  const fontFamily = `"${family}", sans-serif`;
  return (
    <div className="cb-preview-font" style={{ fontFamily }}>
      <div className="cb-preview-font-hero">Aa Bb Cc</div>
      <div className="cb-preview-font-sample">{t('editor.contentBrowser.preview.fontSample')}</div>
      <div className="cb-preview-font-glyphs">
        ABCDEFGHIJKLMNOPQRSTUVWXYZ
        <br />
        abcdefghijklmnopqrstuvwxyz
        <br />
        0123456789 &amp;.,!?@#
      </div>
      <div className="cb-preview-font-name">{name}</div>
    </div>
  );
}
