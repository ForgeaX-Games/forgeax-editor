import type { ComponentType } from 'react';

let preview: ComponentType | undefined;

/** Host injection keeps GPU/App assembly out of the business-panel package. */
export function registerVfxPreview(component: ComponentType): void {
  preview = component;
}

export function getVfxPreview(): ComponentType | undefined {
  return preview;
}
