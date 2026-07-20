/**
 * AppKit SDK — host entry mount points and structured error class.
 *
 * This file is the SSOT for AppKit. It lives in the interface layer because
 * AppKit is a business-agnostic app framework: any app (editor, and future
 * chat/workbench L2 apps) is mounted through these primitives. The editor
 * repo re-exports this surface from `@forgeax/editor/app-kit` for backward
 * compatibility, but the implementation lives here.
 *
 * Three named exports drive AI-user discoverability of forgeax apps:
 *   - defineApp        : declarative manifest constructor (pass-through)
 *   - mountComposition : composition entry mount point (P0 placeholder —
 *                        entryUrl validation only; real composition lands
 *                        in a later phase)
 *   - AppKitError      : structured error class with code / hint / expected
 *
 * Charter P3 (explicit failure, AI-user property access):
 *   AppKitError instances expose three own-properties — `code`, `hint`,
 *   `expected` — so callers branch on `err.code` without parsing
 *   `err.message`. The message is a human-readable composition for logs.
 *
 * Standalone iframe-mount removal (requirements AC-09 / plan-strategy §7 M3):
 *   The former host-side standalone iframe mount entry (and its options
 *   interface) has been removed. The standalone editor host collapsed onto a
 *   single realm and mounts through React `createRoot` directly (see editor
 *   `standalone/main.tsx`), so the iframe-based mount point carried no live
 *   consumer. `defineApp` / `mountComposition` / `AppKitError` are unrelated
 *   symbols and stay.
 */

export interface AppManifestPanel {
  id: string;
}

export interface AppManifest {
  id: string;
  entryUrl: string;
  panels: AppManifestPanel[];
  surfaces: unknown[];
  routes: unknown[];
}

export interface DefinedApp<S = AppManifest> {
  manifest: S;
}

/**
 * Legacy mount option shape kept on the type surface for `mountComposition`,
 * which is still a P0 placeholder.
 */
export interface MountOptions {
  entryUrl?: string;
}

export interface AppKitErrorInit {
  code: string;
  hint: string;
  expected: string | object;
}

export class AppKitError extends Error {
  readonly code: string;
  readonly hint: string;
  readonly expected: string | object;

  constructor(init: AppKitErrorInit) {
    super(`[${init.code}] ${init.hint}`);
    this.name = 'AppKitError';
    this.code = init.code;
    this.hint = init.hint;
    this.expected = init.expected;
  }
}

export function defineApp<S>(spec: S): DefinedApp<S> {
  return { manifest: spec };
}

function requireEntryUrl(opts: MountOptions, fnName: string): void {
  if (!opts || typeof opts.entryUrl !== 'string' || opts.entryUrl.length === 0) {
    throw new AppKitError({
      code: 'MISSING_ENTRY_URL',
      hint: `Provide entryUrl in ${fnName}({ entryUrl })`,
      expected: 'string url',
    });
  }
}

export function mountComposition(opts: MountOptions): void {
  requireEntryUrl(opts, 'mountComposition');
}
