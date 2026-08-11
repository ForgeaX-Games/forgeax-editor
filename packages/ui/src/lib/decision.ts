import type { ReactNode } from 'react';

export type Decision = 'primary' | 'secondary' | 'cancel';

export interface DecisionOptions {
  title: ReactNode;
  description?: ReactNode;
  primaryText: string;
  secondaryText: string;
  cancelText?: string;
  primaryDestructive?: boolean;
  secondaryDestructive?: boolean;
}

type DecisionDispatcher = (options: DecisionOptions) => Promise<Decision>;

let dispatcher: DecisionDispatcher | null = null;

export function setDecisionDispatcher(next: DecisionDispatcher | null): () => void {
  dispatcher = next;
  return () => {
    if (dispatcher === next) dispatcher = null;
  };
}

export function decide(options: DecisionOptions): Promise<Decision> {
  if (!dispatcher) return Promise.resolve('cancel');
  return dispatcher(options);
}
