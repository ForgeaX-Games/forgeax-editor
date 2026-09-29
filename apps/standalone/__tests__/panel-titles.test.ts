// panel-titles.test.ts — guards the Editor panel-title SSOT against rot.
//
// The standalone composition consumes createEditorPanelsExtension, which
// derives every descriptor title from editor-core's shared panel metadata.
// Keep the assertion on that owner rather than duplicating a title table in
// the side-effectful standalone entry.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { EDITOR_PANELS, EDITOR_PANEL_TITLES } from '@forgeax/editor-core';

const main = readFileSync(resolve(import.meta.dir, '../main.tsx'), 'utf8');

describe('standalone EDITOR_PANEL_TITLES', () => {
  it('provides a display title for every core editor panel id', () => {
    expect(main).toContain('createEditorPanelsExtension({ SceneEditor: StandaloneSceneEditor })');
    for (const id of EDITOR_PANELS) {
      expect(EDITOR_PANEL_TITLES[id], `missing title for '${id}'`).toMatch(/\S/);
    }
  });
});
