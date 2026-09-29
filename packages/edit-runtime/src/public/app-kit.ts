/**
 * AppKit SDK — public re-export facade. The SSOT lives in App Shell
 * (`@forgeax/app-shell/application`), because AppKit is a business-agnostic app
 * framework: any independent app (Editor, Chat, or future product surface) is mounted through it.
 *
 * This facade keeps `@forgeax/editor/app-kit` working for existing consumers
 * while the implementation lives one layer down. The dependency direction is
 * editor → App Shell (allowed); App Shell does not import editor, so there
 * is no cycle.
 *
 * Charter F1 (single-entry indexability): Editor forwards to the public
 * `@forgeax/app-shell/application` entrypoint instead of owning a second AppKit.
 *
 * AC-09 (M3): the standalone iframe-mount entry + its options interface were
 * deep-removed in interface — the editor host mounts via React createRoot
 * (single-realm collapse), so this shim no longer re-exports them.
 */

export {
  defineApp,
  mountComposition,
  AppKitError,
} from '@forgeax/app-shell/application';

export type {
  AppKitErrorInit,
  AppManifest,
  AppManifestPanel,
  DefinedApp,
  MountOptions,
} from '@forgeax/app-shell/application';

/**
 * Host-side composition seam. The host supplies already-derived panel and
 * action projections; this helper intentionally does not create a registry or
 * execute an operation.
 */
export interface EditorHostInjection<Panel = unknown, Action = unknown> {
  readonly panels: Readonly<Record<string, Panel>>;
  readonly actions?: readonly Action[];
}

export function defineEditorHost<T extends EditorHostInjection>(host: T): T {
  return host;
}
