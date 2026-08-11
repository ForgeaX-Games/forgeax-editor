import { prompt as promptDialog, type PromptOptions } from '@forgeax/editor-ui/prompt';

/**
 * Content Browser owns this interaction scope across both its in-tree controls
 * and portalled overlays. The shell uses the same data attribute to keep the
 * footer drawer open while a Content Browser control is being used.
 */
export const CONTENT_BROWSER_INTERACTION_SCOPE = 'content-browser';

export const contentBrowserInteractionAttrs = {
  'data-fx-interaction-scope': CONTENT_BROWSER_INTERACTION_SCOPE,
} as const;

/** Opens a shared prompt while preserving Content Browser ownership after the
 * prompt is portalled to document.body. */
export function contentBrowserPrompt(options: PromptOptions): Promise<string | null> {
  return promptDialog({
    ...options,
    interactionScope: CONTENT_BROWSER_INTERACTION_SCOPE,
  });
}
