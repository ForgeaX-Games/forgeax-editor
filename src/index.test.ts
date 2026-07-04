// @forgeax/editor — root entry integration test (AC-03 + AC-04)
//
// This test runs in the in-repo bun test context. It uses a relative
// './index' import (not the `@forgeax/editor` bare specifier) because the
// file: protocol resolution path is exercised separately at the verify step
// (AC-04 standalone consumer install). Here we only assert the static
// manifest shape produced by defineApp.
//
// Plan anchors:
//   plan-strategy §2 D-5 (zero-transitive root entry: defineApp + EDITOR_PANELS only)
//   requirements §5 AC-03 (manifest.id === 'editor', root entry resolves)
//   requirements §5 AC-04 (manifest.panels 8 elements, sorted = EDITOR_PANELS)

import { describe, expect, test } from 'bun:test';

import * as mod from './index';
// Bypass the editor-shared barrel (which transitively loads engine-runtime
// via editor-core); read EDITOR_PANELS straight from its manifest file —
// same source the implementation reads. See src/index.ts comment block.
import { EDITOR_PANELS } from '../packages/editor-core/src/manifest';

describe('@forgeax/editor root entry', () => {
  test('default export carries a manifest object', () => {
    expect(mod.default).toBeDefined();
    expect(typeof mod.default.manifest).toBe('object');
    expect(mod.default.manifest).not.toBeNull();
  });

  test('manifest.id === "editor"', () => {
    expect(mod.default.manifest.id).toBe('editor');
  });

  test('manifest.entryUrl is the editor viewport-only URL', () => {
    expect(mod.default.manifest.entryUrl).toBe(
      'http://127.0.0.1:15280/?viewportOnly=1',
    );
  });

  test('manifest.surfaces and manifest.routes are empty arrays (OOS-09 placeholder)', () => {
    expect(Array.isArray(mod.default.manifest.surfaces)).toBe(true);
    expect(mod.default.manifest.surfaces).toHaveLength(0);
    expect(Array.isArray(mod.default.manifest.routes)).toBe(true);
    expect(mod.default.manifest.routes).toHaveLength(0);
  });

  test('named manifest export references the same object as default.manifest', () => {
    expect((mod as { manifest: unknown }).manifest).toBe(mod.default.manifest);
  });

  test('manifest.panels.map(p => p.id).sort() equals EDITOR_PANELS sorted (8 panels)', () => {
    const panelIds = (mod.default.manifest.panels as Array<{ id: string }>)
      .map((p) => p.id)
      .slice()
      .sort();
    const expected = [...EDITOR_PANELS].sort();
    expect(panelIds).toEqual(expected);
    expect(panelIds).toHaveLength(EDITOR_PANELS.length);
  });
});
