import type { ReactNode } from 'react';

export interface PromptOptions {
  title: ReactNode;
  description?: ReactNode;
  label?: ReactNode;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
  multiline?: boolean;
  /**
   * Synchronous per-keystroke validator. Return `null` if `value` is legal, or
   * an ERROR MESSAGE string that will be shown inline under the input; while a
   * message is present the Confirm button is disabled and submit/Enter is a
   * no-op. `validate` runs against the RAW input value (no trim) so callers
   * that need trim semantics should trim inside the validator.
   *
   * This is a UX-side EARLY-fail gate — the applier remains the SSOT
   * (north-star §9); the validator here should USE the same rule set the
   * applier enforces so the two never disagree. Example: pass
   * `validateAssetBasename` from `@forgeax/editor-core` for folder / rename
   * prompts (see feedbacks/2026-07-23-assets-create-folder-name-validation-*).
   */
  validate?: (value: string) => string | null;
}

type PromptDispatcher = (options: PromptOptions) => Promise<string | null>;

let dispatcher: PromptDispatcher | null = null;

export function setPromptDispatcher(next: PromptDispatcher | null): () => void {
  dispatcher = next;
  return () => {
    if (dispatcher === next) dispatcher = null;
  };
}

export function prompt(options: PromptOptions): Promise<string | null> {
  if (!dispatcher) return Promise.resolve(null);
  return dispatcher(options);
}
