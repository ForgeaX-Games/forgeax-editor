// editor-component-meta.ts — editor-owned component metadata SSOT
//
// The engine (ECS #924 "extensible component metadata") exposes an open,
// MUTABLE `Component.meta` map that the ECS core assigns NO meaning to and
// deliberately leaves extensible for higher-level consumers *after*
// registration. Per the engine boundary decision (engine-harness feedback
// 2026-07-23-component-meta-injection-editorhidden), editor-specific hints must
// NOT be baked into engine component definitions. Instead the editor owns this
// schema-validated config and injects it into each token's `meta.editor`
// namespace once, after the engine has registered its components.
//
// Canonical use: `{ hidden: true }` drops internal / derived / non-editable
// components (Entity / Children / ChildOf) from the Inspector, replacing the
// drift-prone hard-coded exclude lists with a single editor SSOT that stays
// aligned with — but does not pollute — the engine registry.

import { getRegisteredComponents } from '@forgeax/engine-ecs';
import type { Component } from '@forgeax/engine-ecs';
import rawConfig from './editor-component-meta.json';

/** Playback-transport field names an animation component declares so a generic
 *  preview UI can drive it without hardcoding field names (animation-preview M1).
 *  Long-term the producer owns this contract as engine `meta.animation`
 *  (engine-harness feedback 2026-08-03-animation-player-needs-playback-contract-meta);
 *  until that lands the editor overlay carries the identical shape. */
export interface AnimationTransportDescriptor {
  /** Field holding the clip slots (array<shared<AnimationClip>,N>). */
  readonly clips: string;
  /** Field holding per-slot playback positions in seconds. */
  readonly times: string;
  /** Field holding per-slot blend weights. */
  readonly weights: string;
  /** Field holding per-slot playback speed multipliers. */
  readonly speeds: string;
  /** Field holding the component-wide paused flag. */
  readonly paused: string;
  /** The slot the generic transport bar drives (primary clip). */
  readonly clipIndex: number;
}

/** Playback contract for an animation component: the transport field names plus
 *  the runtime-field classification the preview snapshot/restore defense reads.
 *  `runtimeFields` lists the fields preview writes and/or per-frame playback
 *  mutates — they are NOT authored intent, so the editor snapshots them before
 *  the first preview write and restores them at the save/play/selection-change
 *  boundaries (keeps previews from polluting the saved document). */
export interface AnimationComponentMeta {
  readonly transport: AnimationTransportDescriptor;
  readonly runtimeFields: readonly string[];
}

/** Editor-owned per-component metadata, injected into `Component.meta.editor`. */
export interface EditorComponentMeta {
  /** Drop the component from the Inspector (internal / derived / non-editable). */
  readonly hidden?: boolean;
  /** Bespoke Inspector editor: `editorId` resolves through the panels bespoke
   *  registry (panels/src/bespoke-editors.ts); `hint` is the fallback text when
   *  no editor is registered for the id. */
  readonly bespoke?: { readonly editorId: string; readonly hint?: string };
  /** Interim playback contract for animation components (engine meta.animation
   *  wins over this overlay once the producer declares it — see schema.ts). */
  readonly animation?: AnimationComponentMeta;
}

/** The `Component.meta` namespace key the editor overlay lives under. */
const EDITOR_META_KEY = 'editor';

function validateBespoke(name: string, raw: unknown): void {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`editor-component-meta: "${name}.bespoke" must be an object`);
  }
  const { editorId, hint, ...rest } = raw as Record<string, unknown>;
  if (typeof editorId !== 'string' || editorId.length === 0) {
    throw new Error(`editor-component-meta: "${name}.bespoke.editorId" must be a non-empty string`);
  }
  if (hint !== undefined && typeof hint !== 'string') {
    throw new Error(`editor-component-meta: "${name}.bespoke.hint" must be a string`);
  }
  const unknownKeys = Object.keys(rest);
  if (unknownKeys.length > 0) {
    throw new Error(`editor-component-meta: "${name}.bespoke" has unknown keys: ${unknownKeys.join(', ')}`);
  }
}

function validateAnimation(name: string, raw: unknown): void {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`editor-component-meta: "${name}.animation" must be an object`);
  }
  const { transport, runtimeFields, ...rest } = raw as Record<string, unknown>;
  if (transport === null || typeof transport !== 'object' || Array.isArray(transport)) {
    throw new Error(`editor-component-meta: "${name}.animation.transport" must be an object`);
  }
  const t = transport as Record<string, unknown>;
  for (const key of ['clips', 'times', 'weights', 'speeds', 'paused'] as const) {
    if (typeof t[key] !== 'string' || (t[key] as string).length === 0) {
      throw new Error(`editor-component-meta: "${name}.animation.transport.${key}" must be a non-empty field name`);
    }
  }
  if (typeof t.clipIndex !== 'number' || !Number.isInteger(t.clipIndex) || t.clipIndex < 0) {
    throw new Error(`editor-component-meta: "${name}.animation.transport.clipIndex" must be a non-negative integer`);
  }
  const unknownTransportKeys = Object.keys(t).filter(
    (k) => !['clips', 'times', 'weights', 'speeds', 'paused', 'clipIndex'].includes(k),
  );
  if (unknownTransportKeys.length > 0) {
    throw new Error(`editor-component-meta: "${name}.animation.transport" has unknown keys: ${unknownTransportKeys.join(', ')}`);
  }
  if (!Array.isArray(runtimeFields) || runtimeFields.some((f) => typeof f !== 'string' || f.length === 0)) {
    throw new Error(`editor-component-meta: "${name}.animation.runtimeFields" must be an array of non-empty field names`);
  }
  const unknownKeys = Object.keys(rest);
  if (unknownKeys.length > 0) {
    throw new Error(`editor-component-meta: "${name}.animation" has unknown keys: ${unknownKeys.join(', ')}`);
  }
}

/**
 * Validate the JSON config shape at load (fail-fast — a malformed editor SSOT
 * is a build-time/programmer error, not a silent runtime skip).
 */
function validateConfig(raw: unknown): Readonly<Record<string, EditorComponentMeta>> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('editor-component-meta: config root must be an object map of component → meta');
  }
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`editor-component-meta: entry "${name}" must be an object`);
    }
    const { hidden, bespoke, animation, ...rest } = value as Record<string, unknown>;
    if (hidden !== undefined && typeof hidden !== 'boolean') {
      throw new Error(`editor-component-meta: "${name}.hidden" must be a boolean`);
    }
    if (bespoke !== undefined) validateBespoke(name, bespoke);
    if (animation !== undefined) validateAnimation(name, animation);
    const unknownKeys = Object.keys(rest);
    if (unknownKeys.length > 0) {
      throw new Error(`editor-component-meta: "${name}" has unknown keys: ${unknownKeys.join(', ')}`);
    }
  }
  return raw as Readonly<Record<string, EditorComponentMeta>>;
}

/** The validated editor-metadata SSOT (component name → editor meta). */
export const EDITOR_COMPONENT_META = validateConfig(rawConfig);

/** Names whose overlay has already been injected — per-name guard so a
 *  component registered AFTER the first apply (lazy subsystem import, test
 *  boot order) still gets its overlay on a later call. */
const _appliedTo = new Set<string>();

/**
 * Inject the editor-metadata config into each registered component's
 * `meta.editor` namespace. Idempotent and safe to call before the engine is
 * loaded (unknown names are skipped and RETRIED on the next call — the guard
 * is per-name, not one-shot). The engine leaves `Component.meta` mutable
 * after registration precisely for this higher-level overlay; we never touch
 * the frozen token.
 *
 * `config` is injectable for tests; production callers use the JSON SSOT.
 */
export function applyEditorComponentMeta(
  config: Readonly<Record<string, EditorComponentMeta>> = EDITOR_COMPONENT_META,
): void {
  let registry: ReadonlyMap<string, Component>;
  try {
    registry = getRegisteredComponents();
  } catch {
    return; // engine not loaded yet (SSR / headless) — retry on next call
  }
  for (const [name, editorMeta] of Object.entries(config)) {
    if (_appliedTo.has(name)) continue;
    const comp = registry.get(name);
    if (comp === undefined) continue; // not registered yet — retried on a later call
    const meta = comp.meta as Record<string, unknown>;
    // The engine (ECS #924) leaves `meta` mutable for exactly this overlay.
    // Guard the write so an older engine pin that still froze `meta` degrades
    // gracefully (feature dormant) instead of throwing at editor boot; mark
    // applied either way so a permanently-frozen token is not retried on
    // every schema build.
    try {
      meta[EDITOR_META_KEY] = { ...(meta[EDITOR_META_KEY] as EditorComponentMeta | undefined), ...editorMeta };
    } catch {
      // frozen meta (pre-#924 engine) — overlay stays absent; readers see undefined.
    }
    _appliedTo.add(name);
  }
}

/** Read a component's editor-injected `meta.editor` overlay (or `undefined`). */
export function editorMetaOf(comp: Component): EditorComponentMeta | undefined {
  return (comp.meta as { editor?: EditorComponentMeta } | undefined)?.editor;
}

/** Test-only: reset the per-name apply guard so a fresh injection can run. */
export function _resetEditorComponentMeta(): void {
  _appliedTo.clear();
}
