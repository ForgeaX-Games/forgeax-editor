import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from '@forgeax/editor-core/i18n';
import type { FilePreviewInput } from '../types';
import { resolveLanguage } from '../ext-language';
import { decideHighlight } from '../code-preview-policy';
import { highlightToHtml } from '../highlighter';

/** Claims text files whose extension maps to a known language. Plain text with
 *  no known language is left to the fallback renderer's <pre>. */
export function matchesCode(input: FilePreviewInput): boolean {
  return input.content != null && resolveLanguage(input.ext) !== undefined;
}

export function CodePreview(input: FilePreviewInput): ReactNode {
  const { content, ext, size, name } = input;
  const { i18n } = useTranslation();
  const zh = i18n.language === 'zh';
  const decision = decideHighlight({ ext, size, content });
  const targetLang = decision.highlight ? decision.lang : null;
  const label = resolveLanguage(ext)?.label ?? ext.toUpperCase();
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    setHtml(null);
    if (targetLang == null || content == null) return;
    let cancelled = false;
    void highlightToHtml(content, targetLang)
      .then((out) => { if (!cancelled) setHtml(out); })
      .catch(() => { if (!cancelled) setHtml(null); });
    return () => { cancelled = true; };
  }, [content, targetLang]);

  const skippedForSize = !decision.highlight && decision.reason === 'too-large';

  return (
    <div className="fx-fp-code" data-lang={resolveLanguage(ext)?.lang ?? 'text'}>
      <div className="fx-fp-code-head">
        <span className="fx-fp-badge">{label}</span>
        {skippedForSize && (
          <span className="fx-fp-hint">
            {zh ? '文件较大，已跳过高亮' : 'Large file — highlighting skipped'}
          </span>
        )}
      </div>
      {html != null
        ? <div className="fx-fp-code-shiki" dangerouslySetInnerHTML={{ __html: html }} />
        : <pre className="fx-fp-code-plain" aria-label={name}>{content}</pre>}
    </div>
  );
}
