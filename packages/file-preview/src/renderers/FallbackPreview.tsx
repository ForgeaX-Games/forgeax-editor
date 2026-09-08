import type { ReactNode } from 'react';
import { useTranslation } from '@forgeax/editor-core/i18n';
import type { FilePreviewInput } from '../types';

/** Generic presentation used when no renderer claims the file: decoded text is
 *  shown verbatim; anything binary gets the neutral "no preview" note. This is
 *  the host's fallthrough, not a registered renderer, so plugins never see a
 *  catch-all competing with their `match`. */
export function FallbackPreview({ content }: FilePreviewInput): ReactNode {
  const { t } = useTranslation();
  if (content != null) return <pre className="fx-fp-code-plain">{content}</pre>;
  return <div className="fx-fp-note">{t('editor.contentBrowser.preview.noTextPreview')}</div>;
}
