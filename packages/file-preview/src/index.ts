export { FilePreview } from './FilePreview';
export {
  registerFilePreviewRenderer,
  resolveFilePreviewRenderer,
  listFilePreviewRenderers,
} from './registry';
export type { FilePreviewInput, FilePreviewRenderer, FilePreviewFamily } from './types';
export { resolveLanguage, type LanguageResolution } from './ext-language';
export {
  decideHighlight,
  MAX_HIGHLIGHT_BYTES,
  MAX_HIGHLIGHT_LINES,
  type HighlightDecision,
} from './code-preview-policy';
