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
