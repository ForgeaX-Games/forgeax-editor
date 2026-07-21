import * as React from 'react';
import { Toaster } from '../components/toaster';
import { ConfirmProvider } from './confirm-provider';
import { PromptProvider } from './prompt-provider';

export function EditorOverlayProvider({ children }: { children: React.ReactNode }) {
  return (
    <ConfirmProvider>
      <PromptProvider>
        {children}
        <Toaster />
      </PromptProvider>
    </ConfirmProvider>
  );
}
