import {
  createEditorRuntimeEntry,
  EDITOR_RUNTIME_ENTRY_CAPABILITIES,
  EDITOR_RUNTIME_ENTRY_CONTRACT_VERSION,
  EDITOR_RUNTIME_ENTRY_ID,
} from '@forgeax/editor/bridge';

/**
 * FXE backend entry for the released Editor runtime. The host receives the
 * public entry and mounts its real ViewportComponent; no IDE state or private
 * Editor package is imported here.
 */
export const extension = Object.freeze({
  id: EDITOR_RUNTIME_ENTRY_ID,
  contractVersion: EDITOR_RUNTIME_ENTRY_CONTRACT_VERSION,
  runtimeKind: 'world-backed' as const,
  owner: 'editor-edit-runtime' as const,
  capabilities: EDITOR_RUNTIME_ENTRY_CAPABILITIES,
  createRuntimeEntry: createEditorRuntimeEntry,
});

export function activate() {
  return createEditorRuntimeEntry();
}
