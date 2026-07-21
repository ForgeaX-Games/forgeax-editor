// @forgeax/editor/protocol — VAG_* postMessage schema SSOT.
//
// 8 zod schemas covering every VAG_* message type observed on the cross-realm
// wire. Naming is strictly paired:
//
//   Vag<Name>Schema  — runtime z.object validator (consumer side)
//   Vag<Name>Message — TypeScript type derived via z.infer<typeof ...>
//
// Two shape families:
//   payload-wrapped { type, payload: {…} } — CONSOLE, NETWORK, FPS_STATS
//   type-only       { type }                — DEVICE_LOST, PREVIEW_DISPOSE,
//                                             PREVIEW_PAUSE, PREVIEW_PLAY,
//                                             PREVIEW_RELOAD
//
// Fields not present on the wire today are NOT added speculatively — schemas
// surface real divergence instead of silently accepting drift.

import { z } from 'zod';

// ── 1. VAG_CONSOLE ───────────────────────────────────────────────────────────
// Producer: editor-runtime/main.tsx:267,272,275 (console proxy + global error).
// Carries a single console line + level + ts. Consumer pushes to the in-UI
// Console panel.
export const VagConsoleSchema = z.object({
  type: z.literal('VAG_CONSOLE'),
  payload: z.object({
    level: z.enum(['log', 'warn', 'error', 'info', 'debug']),
    text: z.string(),
    ts: z.number(),
  }),
});
export type VagConsoleMessage = z.infer<typeof VagConsoleSchema>;

// ── 2. VAG_NETWORK ───────────────────────────────────────────────────────────
// Producer: play-runtime/main.ts + edit-runtime/main.tsx network bridge
// (fetch / XHR / WebSocket proxy). Carries one network request summary. Consumer
// pushes to the in-UI Network panel (asset/HTTP/WS debugging — 404s, 503s, …).
export const VagNetworkSchema = z.object({
  type: z.literal('VAG_NETWORK'),
  payload: z.object({
    kind: z.enum(['fetch', 'xhr', 'ws']),
    method: z.string(),
    url: z.string(),
    status: z.number(), // HTTP status; 0 = failed/pending; for ws: 101 open / 0 closed
    ms: z.number(), // duration (ms); ws: time-to-open
    ok: z.boolean(),
    ts: z.number(),
  }),
});
export type VagNetworkMessage = z.infer<typeof VagNetworkSchema>;

// ── 3. VAG_DEVICE_LOST ───────────────────────────────────────────────────────
// Producer: engine surface (loss event broadcast); see PreviewMode.tsx:151.
// Type-only ping — interface reacts by reloading the iframe.
export const VagDeviceLostSchema = z.object({
  type: z.literal('VAG_DEVICE_LOST'),
});
export type VagDeviceLostMessage = z.infer<typeof VagDeviceLostSchema>;

// ── 4. VAG_FPS_STATS ────────────────────────────────────────────────────────
// Producer: editor-runtime/main.tsx:254. Carries a per-second fps integer.
// Consumer: EditMode.tsx:245, PreviewMode.tsx:146.
export const VagFpsStatsSchema = z.object({
  type: z.literal('VAG_FPS_STATS'),
  payload: z.object({
    fps: z.number(),
  }),
});
export type VagFpsStatsMessage = z.infer<typeof VagFpsStatsSchema>;

// ── 5. VAG_PREVIEW_DISPOSE ───────────────────────────────────────────────────
// Producer: PreviewMode.tsx:287 / 324 / 414 (interface). Type-only command
// asking the preview iframe to dispose its engine before src reset / unmount.
export const VagPreviewDisposeSchema = z.object({
  type: z.literal('VAG_PREVIEW_DISPOSE'),
});
export type VagPreviewDisposeMessage = z.infer<typeof VagPreviewDisposeSchema>;

// ── 6. VAG_PREVIEW_PAUSE ─────────────────────────────────────────────────────
// Producer: PreviewMode.tsx:407 (sendToGame helper). Type-only.
export const VagPreviewPauseSchema = z.object({
  type: z.literal('VAG_PREVIEW_PAUSE'),
});
export type VagPreviewPauseMessage = z.infer<typeof VagPreviewPauseSchema>;

// ── 7. VAG_PREVIEW_PLAY ──────────────────────────────────────────────────────
// Producer: PreviewMode.tsx:407 (sendToGame helper). Type-only.
export const VagPreviewPlaySchema = z.object({
  type: z.literal('VAG_PREVIEW_PLAY'),
});
export type VagPreviewPlayMessage = z.infer<typeof VagPreviewPlaySchema>;

// ── 8. VAG_PREVIEW_RELOAD ────────────────────────────────────────────────────
// Producer: interface preview / engine HMR path. Type-only — receiver does
// location.reload() (editor-runtime/main.tsx:326).
export const VagPreviewReloadSchema = z.object({
  type: z.literal('VAG_PREVIEW_RELOAD'),
});
export type VagPreviewReloadMessage = z.infer<typeof VagPreviewReloadSchema>;

// ── sendVagMessage — generic typed postMessage helper ───────────────────────────
//
// Replaces every bare `postMessage({ type: 'VAG_*', ... })` call site with
// a compile-time-checked alternative. The `payload` argument is type-inferred
// via z.infer against the schema's inner payload shape, closing the OOS-9 gap
// where call sites silently omit required fields (charter P3 fail-fast).
//
// Behaviour:
//   - Schema safeParse passes → postMessage(target, { type, payload }, '*')
//   - Schema safeParse fails  → throw VagMessageError (structured, P3)
//   - target is null/undefined → no-op return (preserves optional-chain semantics)
//   - postMessage itself is NOT wrapped in try/catch — cross-origin errors
//     are the caller's existing problem (plan-strategy §2 D-6)
//
// Anchors:
//   requirements §5 AC-15 (z.infer compile-time constraint)
//   requirements §5 AC-16 (structured failure, charter P3)
//   plan-strategy §2 D-6 (throw, not Result; no-op on null target)
//   plan-strategy §8 (VagMessageError unified code/hint/expected)

/**
 * Extract the inner payload type from a VAG schema.
 * For payload-wrapped schemas (most common), this is the `payload` field type.
 * For type-only schemas (VAG_PREVIEW_*), this is `Record<string, never>`.
 */

export type VagSchemaTypes = z.infer<ReturnType<typeof vagSchemaUnion>>;

function vagSchemaUnion() {
  return z.union([
    VagConsoleSchema, VagDeviceLostSchema, VagFpsStatsSchema,
    VagPreviewDisposeSchema, VagPreviewPauseSchema, VagPreviewPlaySchema,
    VagPreviewReloadSchema,
  ]);
}

// deno-lint-ignore no-explicit-any

export type PayloadOf<S extends z.ZodType<{ type: string; payload?: any }>> =
  z.input<S> extends { payload: infer P } ? P : Record<string, never>;

/**
 * Structured error for schema-mismatch failures in `sendVagMessage`.
 *
 * Conforms to charter P3 (explicit failure): properties `.code`, `.hint`,
 * `.expected` are machine-readable and designed for attribute access by
 * downstream AI consumers. `.issues` carries the raw ZodIssue[] for
 * diagnostics, but AI consumers should use the structured fields first.
 */
export class VagMessageError extends Error {
  /** Machine-readable error code. Fixed to 'VAG_SCHEMA_MISMATCH'. */
  code = 'VAG_SCHEMA_MISMATCH' as const;

  /** Raw Zod validation issues for diagnostics / logging. */
  issues: z.ZodIssue[];

  /** Human + machine-readable recovery hint. */
  hint: string;

  /** What was expected (human-readable). */
  expected: string;

  constructor(issues: z.ZodIssue[], schemaName: string) {
    const pathStr = issues.map((i) => i.path.join('.')).join(', ');
    super(`VAG_SCHEMA_MISMATCH: ${schemaName} validation failed at [${pathStr}]`);
    this.name = 'VagMessageError';
    this.issues = issues;
    this.hint = `Check the payload you're sending against ${schemaName} — one or more fields are missing or have the wrong type.`;
    this.expected = `Payload must satisfy ${schemaName}. See the .issues array for the full Zod validation error list.`;
  }
}

/**
 * Send a typed VAG message via postMessage.
 *
 * @param target  The postMessage target window. null/undefined → no-op.
 * @param schema  A VAG_* zod schema (e.g. VagConsoleSchema).
 * @param payload The inner payload for the message, type-checked via z.infer.
 *
 * @throws {VagMessageError} if payload fails schema validation.
 *
 * @example
 *   sendVagMessage(window.parent, VagConsoleSchema, { level: 'warn', text: 'hi', ts: 0 });
 */
export function sendVagMessage<S extends z.ZodType<{ type: string; payload?: unknown }>>(
  target: Window | null | undefined,
  schema: S,
  payload: PayloadOf<S>,
): void {
  if (target == null) return;

  // Extract the type literal value from the schema's shape. We go through
  // `unknown` first because the generic `S` only guarantees a ZodType, but
  // every VAG_* schema is actually a ZodObject with a `.type` literal field.
  const typeValue = (
    (schema as unknown as z.ZodObject<{ type: z.ZodLiteral<string> }>).shape.type as z.ZodLiteral<string>
  ).value;

  const fullMessage = {
    type: typeValue,
    payload,
  };

  const result = schema.safeParse(fullMessage);
  if (!result.success) {
    throw new VagMessageError(result.error.issues, typeValue);
  }

  target.postMessage(result.data, '*');
}

// ── Receive side — validated dispatch (SSOT mirror of sendVagMessage) ─────────
//
// Every iframe-boundary receiver previously hand-rolled its own
// `addEventListener('message')` + `switch` + ad-hoc `safeParse` (or a raw
// `e.data as T` cast with NO validation, and usually NO origin check). That
// scattering is the robustness/security hole: foreign-origin pages could drive
// `VAG_PREVIEW_*` straight into the engine bus, and
// malformed payloads reached handlers untyped. `onVagMessage` centralizes the
// trust boundary: source gate → origin allowlist → known-type → schema parse →
// typed dispatch, with rejected messages reported (never silently dropped).

/** type-literal → schema map. Includes VAG_NETWORK (absent from vagSchemaUnion). */
const VAG_SCHEMA_BY_TYPE = {
  VAG_CONSOLE: VagConsoleSchema,
  VAG_NETWORK: VagNetworkSchema,
  VAG_DEVICE_LOST: VagDeviceLostSchema,
  VAG_FPS_STATS: VagFpsStatsSchema,
  VAG_PREVIEW_DISPOSE: VagPreviewDisposeSchema,
  VAG_PREVIEW_PAUSE: VagPreviewPauseSchema,
  VAG_PREVIEW_PLAY: VagPreviewPlaySchema,
  VAG_PREVIEW_RELOAD: VagPreviewReloadSchema,
} as const;

export type VagType = keyof typeof VAG_SCHEMA_BY_TYPE;
type VagMessageFor<T extends VagType> = z.infer<(typeof VAG_SCHEMA_BY_TYPE)[T]>;

/** Typed per-type handler map. A handler receives the SCHEMA-VALIDATED message. */
export type VagHandlers = {
  [T in VagType]?: (msg: VagMessageFor<T>, ev: MessageEvent) => void;
};

export type VagRejectReason = 'bad-origin' | 'unknown-type' | 'failed-validation';
export interface VagReject {
  reason: VagRejectReason;
  type: string;
  origin: string;
  issues?: z.ZodIssue[];
}

export interface OnVagMessageOpts {
  /** Origin allowlist. Default: `allowedParentOrigins()`. A function gets the raw origin. */
  allowedOrigins?: readonly string[] | ((origin: string) => boolean);
  /** When set, messages whose `event.source` !== the returned window are dropped
   *  SILENTLY (normal iframe churn — other frames share the message bus). */
  expectSource?: () => Window | null | undefined;
  handlers: VagHandlers;
  /** Called when a VAG_* message is rejected (bad origin / unknown type / failed
   *  validation). Default logs to console.warn — never a silent drop. Interface
   *  callers inject a sink that routes to the health store / log sink. */
  onReject?: (r: VagReject) => void;
}

/** Origins to trust for messages from the embedding shell: this window's own
 *  origin (same-origin prod, where :18920 proxies /preview + /editor) plus the
 *  referrer origin (split-dev, where the shell is a different port). */
export function allowedParentOrigins(): string[] {
  const out = new Set<string>();
  try { out.add(self.origin); } catch { /* no self */ }
  try { if (document.referrer) out.add(new URL(document.referrer).origin); } catch { /* no/odd referrer */ }
  return [...out];
}

function makeOriginPredicate(
  allowed: OnVagMessageOpts['allowedOrigins'],
): (origin: string) => boolean {
  if (typeof allowed === 'function') return allowed;
  const list = allowed ?? allowedParentOrigins();
  // An empty allowlist (e.g. opaque origin) would reject everything and wedge
  // the wire; treat "no derivable origin" as allow-same-origin only.
  const set = new Set(list);
  return (origin) => set.size === 0 ? origin === safeSelfOrigin() : set.has(origin);
}

function safeSelfOrigin(): string {
  try { return self.origin; } catch { return ''; }
}

function defaultReject(r: VagReject): void {
  // eslint-disable-next-line no-console
  console.warn(`[vag] rejected ${r.type} (${r.reason}) from ${r.origin || '<null origin>'}`,
    r.issues ? r.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : '');
}

/**
 * Install a validated VAG_* message receiver. Returns an unsubscribe fn.
 *
 * Pipeline per inbound message:
 *   1. source gate (if `expectSource`) → silent drop on mismatch
 *   2. shape check: object with a string `type` starting `VAG_` → else ignore
 *      (foreign protocols share the bus: forgeax:health, vite HMR, …)
 *   3. origin allowlist → reject `bad-origin`
 *   4. known VAG type → reject `unknown-type`
 *   5. schema safeParse → reject `failed-validation` (carries `issues`)
 *   6. dispatch the validated message to `handlers[type]`
 */
export function onVagMessage(win: Window, opts: OnVagMessageOpts): () => void {
  const originOk = makeOriginPredicate(opts.allowedOrigins);
  const onReject = opts.onReject ?? defaultReject;
  const handlers = opts.handlers as Record<string, ((m: unknown, e: MessageEvent) => void) | undefined>;

  const listener = (ev: MessageEvent): void => {
    if (opts.expectSource) {
      const want = opts.expectSource();
      if (want && ev.source !== want) return; // not our frame — silent
    }
    const data = ev.data as { type?: unknown } | null | undefined;
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
    const type = data.type;
    if (!type.startsWith('VAG_')) return; // foreign protocol on the shared bus — not ours
    if (!originOk(ev.origin)) { onReject({ reason: 'bad-origin', type, origin: ev.origin }); return; }
    const schema = VAG_SCHEMA_BY_TYPE[type as VagType];
    if (!schema) { onReject({ reason: 'unknown-type', type, origin: ev.origin }); return; }
    const result = schema.safeParse(data);
    if (!result.success) {
      onReject({ reason: 'failed-validation', type, origin: ev.origin, issues: result.error.issues });
      return;
    }
    handlers[type]?.(result.data, ev);
  };

  win.addEventListener('message', listener);
  return () => win.removeEventListener('message', listener);
}
