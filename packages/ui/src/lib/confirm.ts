import type { ReactNode } from 'react';

export interface ConfirmOptions {
  title: ReactNode;
  description?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
}

type ConfirmDispatcher = (options: ConfirmOptions) => Promise<boolean>;

let dispatcher: ConfirmDispatcher | null = null;

export function setConfirmDispatcher(next: ConfirmDispatcher | null): () => void {
  dispatcher = next;
  return () => {
    if (dispatcher === next) dispatcher = null;
  };
}

export function confirm(options: ConfirmOptions): Promise<boolean> {
  if (!dispatcher) return Promise.resolve(false);
  return dispatcher(options);
}
