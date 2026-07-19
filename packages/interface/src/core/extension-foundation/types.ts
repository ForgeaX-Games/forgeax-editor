// packages/interface/src/core/extension-foundation/types.ts
//
// Domain-agnostic types shared by the app-shell layer. C = capability union;
// Ctx = per-domain plugin context. Copied verbatim from arrival's
// `extension-foundation/types.ts` — see docs/comm-mechanism-analysis-2026-07-09.md
// §3.4 for the reasoning.

export type Cleanup = () => void | Promise<void>;

export type SetupReturn = Cleanup | void;

export interface ExtensionManifest<C extends string, Ctx = unknown> {
  /** Globally unique within the host system. Kebab-case. */
  readonly id: string;
  /** Semver of this plugin's contributions. */
  readonly version: string;
  /** Capabilities the host MUST expose for this plugin to activate. */
  readonly requires?: readonly C[];
  /** Capabilities this plugin will add to the host once setup resolves. */
  readonly provides?: readonly C[];
  /** Activation. May return a Cleanup callable (sync or async). */
  readonly setup: (ctx: Ctx) => SetupReturn | Promise<SetupReturn>;
}

export type EventMap = Record<string, unknown>;

export interface BusEvent<E extends EventMap, K extends keyof E = keyof E> {
  readonly topic: K;
  readonly payload: E[K];
}

export type Listener<P> = (payload: P) => void;

export type Middleware<E extends EventMap> = (
  event: BusEvent<E>,
  next: (event: BusEvent<E>) => void,
) => void;

export type ListenerErrorHandler<E extends EventMap> = (
  error: unknown,
  topic: keyof E,
  payload: unknown,
) => void;
