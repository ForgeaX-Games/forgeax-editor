// editor-component-meta.test.ts — editor-owned meta overlay is injected into
// Component.meta.editor post-registration and drives Inspector hiding.
//
// The engine stays agnostic to editor keys (feedback boundary decision); the
// editor SSOT (editor-component-meta.json) is applied onto the mutable
// Component.meta map after the engine registers its components.

import { describe, expect, it, beforeAll } from 'bun:test';
import { ChildOf, Children } from '@forgeax/engine-scene';
import { defineComponent, getRegisteredComponents, resolveComponent } from '@forgeax/engine-ecs';
import { getComponentSchema, isComponentHidden, _resetSchemaCache } from '../scene/schema';
import {
  applyEditorComponentMeta,
  editorMetaOf,
  EDITOR_COMPONENT_META,
  _resetEditorComponentMeta,
} from '../scene/editor-component-meta';

// Reference the runtime tokens so their modules (and thus registration) load.
void ChildOf;
void Children;

beforeAll(() => {
  _resetSchemaCache();
  _resetEditorComponentMeta();
});

describe('editor component meta overlay', () => {
  it('injects meta.editor onto internal components post-registration', () => {
    applyEditorComponentMeta();
    const registry = getRegisteredComponents();
    for (const name of ['Entity', 'Children', 'ChildOf']) {
      const comp = registry.get(name);
      expect(comp, `${name} should be registered`).toBeDefined();
      expect(editorMetaOf(comp!)?.hidden).toBe(true);
    }
  });

  it('does NOT pollute the engine token beyond the editor namespace', () => {
    const childOf = getRegisteredComponents().get('ChildOf')!;
    // Engine never sets `editorHidden`; the overlay lives strictly under `editor`.
    expect((childOf.meta as Record<string, unknown>).editorHidden).toBeUndefined();
    expect(editorMetaOf(childOf)).toEqual({ hidden: true });
  });

  it('isComponentHidden reflects the overlay (internal hidden, business visible)', () => {
    expect(isComponentHidden('Entity')).toBe(true);
    expect(isComponentHidden('Children')).toBe(true);
    expect(isComponentHidden('ChildOf')).toBe(true);
    expect(isComponentHidden('Transform')).toBe(false);
    expect(isComponentHidden('MeshRenderer')).toBe(false);
  });

  it('config SSOT marks exactly the internal components as hidden', () => {
    // The overlay grew past hiding with the animation-preview M1 contract
    // (AnimationPlayer bespoke+animation keys); the HIDDEN set stays the
    // internal components plus the derived engine `Disabled` marker (synced by
    // applySetHidden from EditorHidden intent — users must not edit it
    // directly; docs 2026-08-04-editor-hide-ue-parity-plan).
    const hidden = Object.entries(EDITOR_COMPONENT_META)
      .filter(([, meta]) => meta.hidden === true)
      .map(([name]) => name)
      .sort();
    expect(hidden).toEqual(['ChildOf', 'Children', 'Disabled', 'Entity']);
  });

  it('AnimationPlayer carries the bespoke + animation contract (M1)', () => {
    const meta = EDITOR_COMPONENT_META.AnimationPlayer;
    expect(meta).toBeDefined();
    expect(meta!.hidden).toBeUndefined();
    expect(meta!.bespoke?.editorId).toBe('animation-transport');
    expect(meta!.animation?.transport).toMatchObject({
      clips: 'clips', times: 'times', weights: 'weights',
      speeds: 'speeds', paused: 'paused', clipIndex: 0,
    });
    expect(meta!.animation?.runtimeFields).toEqual(['times', 'speeds', 'paused']);
  });

  // Regression (animation-preview PR #463 CI red): the apply guard was ONE-SHOT
  // — a first apply running before AnimationPlayer registered skipped it and
  // latched `_applied`, so the component NEVER received its overlay and the
  // bespoke transport bar rendered null (import-order flaky). The guard is now
  // per-name: late-registered components are injected on a later call.
  it('late-registered components still receive the overlay (per-name guard)', () => {
    const name = 'R1_OverlayLateRegistrationFixture';
    if (resolveComponent(name) === undefined) {
      // First apply while the fixture is NOT registered — skipped, must not latch.
      applyEditorComponentMeta({ [name]: { bespoke: { editorId: 'late-fixture-editor' } } });
      defineComponent(name, { value: 'f32' });
    }
    applyEditorComponentMeta({ [name]: { bespoke: { editorId: 'late-fixture-editor' } } });
    _resetSchemaCache();
    expect(getComponentSchema(name)?.bespoke?.editorId).toBe('late-fixture-editor');
  });
});
