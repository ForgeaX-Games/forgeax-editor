import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';

// Regression guard for docs/2026-08-06-hierarchy-remove-lock-plan.md (M4):
// the Hierarchy lock affordance was never-wired dead UI and is removed
// outright (D-1, no feature flag). These assertions keep the placeholder
// from being resurrected — if a real lock capability is ever built, it must
// arrive as a gateway op per the plan's north-star §3, not as revived chrome.

const panelsDir = resolve(import.meta.dir, '..');
const hierarchy = readFileSync(resolve(panelsDir, 'Hierarchy.tsx'), 'utf8');
const theme = readFileSync(resolve(panelsDir, '..', '..', 'edit-runtime', 'src', 'theme.css'), 'utf8');
const en = readFileSync(resolve(panelsDir, '..', '..', 'core', 'src', 'i18n', 'locales', 'en.json'), 'utf8');
const zh = readFileSync(resolve(panelsDir, '..', '..', 'core', 'src', 'i18n', 'locales', 'zh.json'), 'utf8');

describe('Hierarchy lock removal', () => {
  it('renders no lock column in rows or the column header', () => {
    expect(hierarchy).not.toContain('className="lock"');
    expect(hierarchy).not.toContain('ch-lock');
    expect(hierarchy).not.toContain('Unlock');
  });

  it('has no Lock item in the entity context menu', () => {
    expect(hierarchy).not.toContain('menu.lock');
    expect(hierarchy).not.toContain('shield-check');
  });

  it('drops the dead lock styles from the theme', () => {
    expect(theme).not.toContain('--w-lock');
    expect(theme).not.toContain('.ch-lock');
    expect(theme).not.toContain('.tn .lock');
  });

  it('drops the dead lock i18n keys', () => {
    for (const locale of [en, zh]) {
      expect(locale).not.toContain('"lock":');
      expect(locale).not.toContain('lockUnavailable');
      expect(locale).not.toContain('folderDisplayOnly');
    }
  });
});
