// Pure policy for whether a text file should be syntax-highlighted. Highlighting
// a very large file blocks the main thread with no real benefit in a small
// detail pane, so above a size/line budget we fall back to plain <pre>. Kept
// side-effect-free so it is trivially unit-testable without React or shiki.

import { resolveLanguage } from './ext-language';

/** Byte budget above which highlighting is skipped. */
export const MAX_HIGHLIGHT_BYTES = 200 * 1024;
/** Line budget above which highlighting is skipped. */
export const MAX_HIGHLIGHT_LINES = 5_000;

export type HighlightDecision =
  | { readonly highlight: true; readonly lang: string; readonly label: string }
  | { readonly highlight: false; readonly reason: 'no-content' | 'unknown-language' | 'too-large' };

export interface HighlightPolicyInput {
  readonly ext: string;
  readonly size: number;
  readonly content?: string;
}

function countLines(text: string): number {
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return lines;
}

/** Decide whether/how to highlight, from the file's extension, size and content. */
export function decideHighlight(input: HighlightPolicyInput): HighlightDecision {
  const { ext, size, content } = input;
  if (content == null) return { highlight: false, reason: 'no-content' };
  const resolved = resolveLanguage(ext);
  if (!resolved) return { highlight: false, reason: 'unknown-language' };
  const byteSize = Math.max(size, content.length);
  if (byteSize > MAX_HIGHLIGHT_BYTES || countLines(content) > MAX_HIGHLIGHT_LINES) {
    return { highlight: false, reason: 'too-large' };
  }
  return { highlight: true, lang: resolved.lang, label: resolved.label };
}
