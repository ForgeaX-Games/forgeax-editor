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

/** Editor-owned per-component metadata, injected into `Component.meta.editor`. */
export interface EditorComponentMeta {
  /** Drop the component from the Inspector (internal / derived / non-editable). */
  readonly hidden?: boolean;
}

/** The `Component.meta` namespace key the editor overlay lives under. */
const EDITOR_META_KEY = 'editor';

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
    const { hidden, ...rest } = value as Record<string, unknown>;
    if (hidden !== undefined && typeof hidden !== 'boolean') {
      throw new Error(`editor-component-meta: "${name}.hidden" must be a boolean`);
    }
    const unknownKeys = Object.keys(rest);
    if (unknownKeys.length > 0) {
      throw new Error(`editor-component-meta: "${name}" has unknown keys: ${unknownKeys.join(', ')}`);
    }
  }
  return raw as Readonly<Record<string, EditorComponentMeta>>;
}

/** The validated editor-metadata SSOT (component name → editor meta). */
export const EDITOR_COMPONENT_META = validateConfig(rawConfig);

let _applied = false;

/**
 * Inject the editor-metadata config into each registered component's
 * `meta.editor` namespace. Idempotent and safe to call before the engine is
 * loaded (unknown names are skipped, the one-shot guard stays unset so a later
 * call retries). The engine leaves `Component.meta` mutable after registration
 * precisely for this higher-level overlay; we never touch the frozen token.
 */
export function applyEditorComponentMeta(): void {
  if (_applied) return;
  let registry: ReadonlyMap<string, Component>;
  try {
    registry = getRegisteredComponents();
  } catch {
    return; // engine not loaded yet (SSR / headless) — retry on next call
  }
  for (const [name, editorMeta] of Object.entries(EDITOR_COMPONENT_META)) {
    const comp = registry.get(name);
    if (comp === undefined) continue;
    const meta = comp.meta as Record<string, unknown>;
    try {
      // The engine (ECS #924) leaves `meta` mutable for exactly this overlay.
      // Guard the write so an older engine pin that still froze `meta` degrades
      // gracefully (feature dormant) instead of throwing at editor boot.
      meta[EDITOR_META_KEY] = { ...(meta[EDITOR_META_KEY] as EditorComponentMeta | undefined), ...editorMeta };
    } catch {
      // frozen meta (pre-#924 engine) — overlay stays absent; readers see undefined.
    }
  }
  _applied = true;
}

/** Read a component's editor-injected `meta.editor` overlay (or `undefined`). */
export function editorMetaOf(comp: Component): EditorComponentMeta | undefined {
  return (comp.meta as { editor?: EditorComponentMeta } | undefined)?.editor;
}

/** Test-only: reset the one-shot apply guard so a fresh injection can run. */
export function _resetEditorComponentMeta(): void {
  _applied = false;
}
