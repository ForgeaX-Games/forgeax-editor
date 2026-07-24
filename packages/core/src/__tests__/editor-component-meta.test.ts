// editor-component-meta.test.ts — editor-owned meta overlay is injected into
// Component.meta.editor post-registration and drives Inspector hiding.
//
// The engine stays agnostic to editor keys (feedback boundary decision); the
// editor SSOT (editor-component-meta.json) is applied onto the mutable
// Component.meta map after the engine registers its components.

import { describe, expect, it, beforeAll } from 'bun:test';
import { ChildOf, Children } from '@forgeax/engine-runtime';
import { getRegisteredComponents } from '@forgeax/engine-ecs';
import { isComponentHidden, _resetSchemaCache } from '../scene/schema';
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

  it('config SSOT lists exactly the internal components as hidden', () => {
    expect(Object.keys(EDITOR_COMPONENT_META).sort()).toEqual(['ChildOf', 'Children', 'Entity']);
    for (const meta of Object.values(EDITOR_COMPONENT_META)) {
      expect(meta.hidden).toBe(true);
    }
  });
});
