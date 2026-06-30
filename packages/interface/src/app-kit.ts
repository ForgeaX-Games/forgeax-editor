/**
 * AppKit SDK — host entry mount points and structured error class.
 *
 * This file is the SSOT for AppKit. It lives in the interface layer because
 * AppKit is a business-agnostic app framework: any app (editor, and future
 * chat/workbench L2 apps) is mounted through these primitives. The editor
 * repo re-exports this surface from `@forgeax/editor/app-kit` for backward
 * compatibility, but the implementation lives here.
 *
 * Four named exports drive AI-user discoverability of forgeax apps:
 *   - defineApp        : declarative manifest constructor (pass-through)
 *   - mountStandalone  : host-side standalone entry mount (creates an
 *                        iframe at app.manifest.entryUrl + binds a host
 *                        listener for VAG_* postMessage traffic; idempotent
 *                        across repeat calls)
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
 * mountStandalone signature (plan-strategy §2 D-5 / D-6):
 *   mountStandalone(app: DefinedApp<S>, opts?: { rootEl?, branding? }): void
 *
 *   - `app.manifest.entryUrl` is the iframe `src` (research §F-6 C-1).
 *   - `opts.rootEl` defaults to `document.body`. A `null` rootEl or a
 *     detached element (one that is not attached to `document`) raises
 *     INVALID_ROOT_EL — there is no fallback.
 *   - Repeated calls remove the previously mounted iframe before creating
 *     the new one (idempotent overwrite, AC-09).
 *   - The host-side `message` listener is bound on `window` (host) once
 *     for the module lifetime; it gates incoming events by
 *     `event.source === currentIframe?.contentWindow` and by
 *     `event.origin` matching the iframe's URL origin (research §F-6
 *     C-3 / C-5). Foreign-origin or stranger-source events are dropped
 *     before any schema-validation path.
 *   - `opts.branding` is reserved for future surface composition (OOS-6);
 *     this revision declares the type only and does not render it.
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
 * which is still a P0 placeholder. `mountStandalone` no longer accepts this
 * shape (see new signature above).
 */
export interface MountOptions {
  entryUrl?: string;
}

export interface MountStandaloneOptions {
  /**
   * Element under which the iframe is appended. Must be attached to
   * `document` at call time — a null or detached element raises
   * INVALID_ROOT_EL. Defaults to `document.body`.
   */
  rootEl?: HTMLElement;
  /**
   * Reserved for future surface-composition branding (OOS-6); currently
   * accepted on the type surface and ignored at runtime.
   */
  branding?: {
    title?: string;
    logoUrl?: string;
  };
  /**
   * BANDAGE flag — temporary opt-out for the studio chrome's chat surface
   * and the Forge agent entry. Used by the standalone editor host
   * (`packages/editor/standalone/`, plan §M4) so the editor can mount the
   * shared App shell without dragging the chat-driven studio chrome along.
   *
   * Semantics:
   *   - `true`  — the App shell does NOT render the ChatPanel container
   *               nor the TopBar Forge entry region.
   *   - `false` / omitted — the App shell renders the full studio chrome
   *               (no behavioural change for studio :18920, AC-16).
   *
   * Plumbing: plain prop drilling on `App.tsx` (one prop, two conditional
   * render sites — see ADR `docs/decisions/0018-editor-consolidation.md`,
   * landed by w16). The flag is intentionally NOT bound to the zustand
   * store's chat slice (`chatpanelCollapsed`, `composerPendingInsert`,
   * `pendingChatPanelBusFlash`), so studio behaviour stays untouched.
   *
   * BANDAGE — scheduled removal: this option exists only until the chat
   * surface migrates out of the interface shell into a dedicated
   * `@forgeax/chat` L2 app. At that point the App shell composes chat
   * from the new package and this boolean disappears with no consumer
   * migration required (treated as the bandage on a temporary wound).
   * Cross-link: requirements §AC-14, plan-strategy §2 D-4, D-9.
   */
  hideChatAndForge?: boolean;
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

// --- mountStandalone runtime state -----------------------------------------

let currentIframe: HTMLIFrameElement | null = null;
let currentOrigin: string | null = null;
let listenerBound = false;

/**
 * Bind the host-side `message` listener exactly once. The listener gates
 * incoming events by the live `currentIframe.contentWindow` and the live
 * `currentOrigin`, so iframe replacement does not require unbinding —
 * the gate naturally ignores events from the prior iframe's contentWindow.
 */
function bindHostListenerOnce(): void {
  if (listenerBound) return;
  if (typeof window === 'undefined') return;
  window.addEventListener('message', (ev: MessageEvent) => {
    // Source gate: drop events that did not come from the iframe we mounted.
    if (!currentIframe || ev.source !== currentIframe.contentWindow) {
      return;
    }
    // Origin gate: drop foreign-origin events before any schema parsing.
    if (currentOrigin && ev.origin !== currentOrigin) {
      return;
    }
    // VAG_* protocol delivery is wired by callers in a later phase
    // (see plan-strategy §2 D-3 / D-4 — schema dispatch stays out of the
    // mount path so app-kit remains zero-transitive).
  });
  listenerBound = true;
}

/**
 * Best-effort origin extraction from an entryUrl string. Returning `null`
 * means "skip the origin gate" — that path is reserved for unparseable URLs
 * which the source gate alone already protects against.
 */
function originFor(entryUrl: string): string | null {
  try {
    return new URL(entryUrl).origin;
  } catch {
    return null;
  }
}

function isAttachedToDocument(el: HTMLElement): boolean {
  if (typeof document === 'undefined') return false;
  return document.contains(el);
}

export function mountStandalone<S extends AppManifest = AppManifest>(
  app: DefinedApp<S>,
  opts?: MountStandaloneOptions,
): void {
  // (a) MISSING_ENTRY_URL — covers both bare-manifest misuse (no .manifest
  //     field) and an empty / undefined entryUrl on a real DefinedApp.
  const manifest =
    app && typeof app === 'object' && 'manifest' in (app as object)
      ? (app as DefinedApp<S>).manifest
      : null;
  const entryUrl =
    manifest && typeof manifest === 'object' && 'entryUrl' in (manifest as object)
      ? (manifest as AppManifest).entryUrl
      : undefined;
  if (typeof entryUrl !== 'string' || entryUrl.length === 0) {
    throw new AppKitError({
      code: 'MISSING_ENTRY_URL',
      hint: 'mountStandalone(app) requires a DefinedApp whose manifest.entryUrl is a non-empty URL string. Wrap your manifest with defineApp(manifest) before calling.',
      expected: { app: { manifest: { entryUrl: 'string url' } } },
    });
  }

  // (b) INVALID_ROOT_EL — null when explicitly set, or a detached element.
  let rootEl: HTMLElement;
  if (opts && 'rootEl' in opts) {
    const candidate = opts.rootEl;
    if (candidate === null || candidate === undefined) {
      throw new AppKitError({
        code: 'INVALID_ROOT_EL',
        hint: 'opts.rootEl must be an HTMLElement attached to document, or omitted to default to document.body.',
        expected: 'HTMLElement attached to document',
      });
    }
    if (!isAttachedToDocument(candidate)) {
      throw new AppKitError({
        code: 'INVALID_ROOT_EL',
        hint: 'opts.rootEl must be attached to document at call time; appendChild(rootEl) before mountStandalone.',
        expected: 'HTMLElement attached to document',
      });
    }
    rootEl = candidate;
  } else {
    if (typeof document === 'undefined' || !document.body) {
      throw new AppKitError({
        code: 'INVALID_ROOT_EL',
        hint: 'mountStandalone requires a DOM document with a body when opts.rootEl is omitted.',
        expected: 'HTMLElement attached to document',
      });
    }
    rootEl = document.body;
  }

  // (c) Idempotent overwrite — drop the prior iframe before creating a new
  //     one. The listener is bound on host window once and gates by the
  //     live currentIframe / currentOrigin variables, so replacing the
  //     iframe does not leak listener state.
  if (currentIframe) {
    currentIframe.remove();
    currentIframe = null;
    currentOrigin = null;
  }

  const iframe = document.createElement('iframe');
  iframe.src = entryUrl;
  rootEl.appendChild(iframe);
  currentIframe = iframe;
  currentOrigin = originFor(entryUrl);

  bindHostListenerOnce();
  // opts.branding intentionally unused (OOS-6).
  void opts?.branding;
  // opts.hideChatAndForge is consumed by the App chrome (App.tsx prop
  // drilling per plan §2 D-4); mountStandalone itself only mounts the
  // iframe, so the value passes through here as a transparent record
  // that the host requested chrome-suppression. Reads of this value
  // happen on the React side, not inside the iframe boundary.
  void opts?.hideChatAndForge;
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
