/**
 * Public, zero-logic facade for the runtime UI diagnostics contract.
 * Selectors are data-read contracts, not browser locators. The
 * internal selector graph and engine World never cross this boundary.
 */
export {
  createRuntimeUiOperations,
  parseRuntimeUiDiagnostics,
  RUNTIME_UI_OPERATION_MANIFEST,
} from '@forgeax/editor-core';
export type {
  RuntimeUiCapabilities,
  RuntimeUiDiagnostics,
  RuntimeUiError,
  RuntimeUiOperations,
  RuntimeUiProvenance,
  RuntimeUiStats,
} from '@forgeax/editor-core';

export { RUNTIME_UI_DIAGNOSTICS_SCHEMA } from '@forgeax/editor-core';
