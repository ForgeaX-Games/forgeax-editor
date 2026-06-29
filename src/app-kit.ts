/**
 * AppKit SDK — re-export shim. The SSOT now lives in the interface layer
 * (`@forgeax/interface/app-kit`), because AppKit is a business-agnostic app
 * framework: any app (editor, future chat/workbench) is mounted through it.
 *
 * This shim keeps `@forgeax/editor/app-kit` working for existing consumers
 * while the implementation lives one layer down. The dependency direction is
 * editor → interface (allowed); interface no longer imports editor, so there
 * is no cycle.
 *
 * Charter F1 (single-entry indexability): the SSOT is one physical file in the
 * interface repo (packages/interface/src/app-kit.ts); editor forwards to it.
 */

export {
  defineApp,
  mountStandalone,
  mountComposition,
  AppKitError,
} from '@forgeax/interface/app-kit';

export type {
  AppKitErrorInit,
  AppManifest,
  AppManifestPanel,
  DefinedApp,
  MountOptions,
  MountStandaloneOptions,
} from '@forgeax/interface/app-kit';
