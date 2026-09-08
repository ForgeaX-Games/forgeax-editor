// Font preview — loads the face via the FontFace API (from the raw-bytes URL)
// and renders a short specimen in it. Migrated from the Content Browser's
// CBFontPreview so font previewing lives with every other file-preview renderer.

import { useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslation } from '@forgeax/editor-core/i18n';
import type { FilePreviewInput } from '../types';

const FONT_EXTS = new Set(['ttf', 'otf', 'woff', 'woff2']);

export function matchesFont(input: FilePreviewInput): boolean {
  return input.family === 'font' || FONT_EXTS.has(input.ext);
}

export function FontPreview({ rawUrl, name }: FilePreviewInput): ReactNode {
  const { t } = useTranslation();
  // A unique, CSS-ident-safe family per instance so re-selections never collide.
  const family = `fx-fp-font-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    setStatus('loading');
    if (typeof FontFace === 'undefined' || !document.fonts) {
      setStatus('error');
      return;
    }
    let cancelled = false;
    const face = new FontFace(family, `url("${rawUrl}")`);
    face
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
        document.fonts.delete(face);
      } catch {
        // deleting a face that never got added is a harmless no-op.
      }
    };
  }, [rawUrl, family]);

  if (status === 'error') {
    return <div className="fx-fp-note">{t('editor.contentBrowser.preview.fontUnavailable')}</div>;
  }
  if (status === 'loading') {
    return <div className="fx-fp-note">{t('editor.contentBrowser.preview.fontLoading')}</div>;
  }

  const fontFamily = `"${family}", sans-serif`;
  return (
    <div className="fx-fp-font" style={{ fontFamily }}>
      <div className="fx-fp-font-hero">Aa Bb Cc</div>
      <div className="fx-fp-font-sample">{t('editor.contentBrowser.preview.fontSample')}</div>
      <div className="fx-fp-font-glyphs">
        ABCDEFGHIJKLMNOPQRSTUVWXYZ
        <br />
        abcdefghijklmnopqrstuvwxyz
        <br />
        0123456789 &amp;.,!?@#
      </div>
      <div className="fx-fp-font-name">{name}</div>
    </div>
  );
}
