// panel-titles.test.ts — guards the host panel-title map against rot.
//
// EDITOR_PANEL_TITLES in main.tsx is host-owned display metadata keyed by the
// core EDITOR_PANELS SSOT. When core gained 'mat-preview' the map was not
// updated, so the dock tab and the Layout menu fell back to the raw id
// ("mat-preview" instead of "Preview"). main.tsx is an entry module with
// bootstrap side effects (not importable in tests), so this pins the mapping
// at source level.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { EDITOR_PANELS } from '@forgeax/editor-core';

const main = readFileSync(resolve(import.meta.dir, '../main.tsx'), 'utf8');

describe('standalone EDITOR_PANEL_TITLES', () => {
  it('provides a display title for every core editor panel id', () => {
    for (const id of EDITOR_PANELS) {
      // Keys with hyphens must be quoted ('mat-preview':); plain identifiers
      // may appear unquoted (hierarchy:). Accept both forms.
      const key = new RegExp(`(?:'${id}'|\\b${id})\\s*:`);
      expect(key.test(main), `missing title for '${id}'`).toBe(true);
    }
  });
});
