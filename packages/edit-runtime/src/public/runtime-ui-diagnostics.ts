/**
 * Public, zero-logic facade for runtime UI diagnostics and material inspection.
 * Selectors are data-read contracts, not browser locators. The internal
 * selector graph and engine World never cross this boundary.
 *
 * MaterialPublicationInspection is queried by authored MaterialAsset GUID.
 * Its publication tuple is independent from transport URL, carrier origin,
 * and runtime generation; those values describe provenance only.
 */
export {
  createRuntimeUiOperations,
  parseRuntimeUiDiagnostics,
  RUNTIME_UI_OPERATION_MANIFEST,
} from '@forgeax/editor-core';
export type {
  MaterialPublicationInspection,
  RuntimeUiCapabilities,
  RuntimeUiDiagnostics,
  RuntimeUiError,
  RuntimeUiOperations,
  RuntimeUiProvenance,
  RuntimeUiStats,
} from '@forgeax/editor-core';

export { RUNTIME_UI_DIAGNOSTICS_SCHEMA } from '@forgeax/editor-core';
