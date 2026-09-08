import type { RuntimeAssetBinding } from '@forgeax/engine-types';

const PREVIEW_RUNTIME_BINDING = Symbol.for('forgeax.editor.preview-runtime-binding');
type BindingGlobal = typeof globalThis & {
  [PREVIEW_RUNTIME_BINDING]?: RuntimeAssetBinding;
};

export function setPreviewRuntimeBinding(binding: RuntimeAssetBinding | undefined): void {
  const owner = globalThis as BindingGlobal;
  if (binding === undefined) delete owner[PREVIEW_RUNTIME_BINDING];
  else owner[PREVIEW_RUNTIME_BINDING] = binding;
}

export function clearPreviewRuntimeBinding(binding: RuntimeAssetBinding | undefined): void {
  const owner = globalThis as BindingGlobal;
  if (owner[PREVIEW_RUNTIME_BINDING] === binding) delete owner[PREVIEW_RUNTIME_BINDING];
}

export function getPreviewRuntimeBinding(): RuntimeAssetBinding | undefined {
  return (globalThis as BindingGlobal)[PREVIEW_RUNTIME_BINDING];
}
