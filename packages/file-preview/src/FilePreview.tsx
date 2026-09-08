import type { ReactNode } from 'react';
import type { FilePreviewInput } from './types';
import { resolveFilePreviewRenderer } from './registry';
import { FallbackPreview } from './renderers/FallbackPreview';
import './renderers/register-builtins';
import './file-preview.css';

/**
 * Host component: resolve the winning renderer for `input` and render it, or
 * fall back to the generic text/binary presentation. The resolved renderer id
 * is surfaced as a data attribute for diagnostics/e2e without leaking internals.
 */
export function FilePreview({ input }: { input: FilePreviewInput }): ReactNode {
  const renderer = resolveFilePreviewRenderer(input);
  const Body = renderer?.component ?? FallbackPreview;
  return (
    <div className="fx-fp" data-preview-renderer={renderer?.id ?? 'fallback'}>
      <Body {...input} />
    </div>
  );
}
