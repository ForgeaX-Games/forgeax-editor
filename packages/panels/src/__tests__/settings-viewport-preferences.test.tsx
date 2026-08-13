import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const settingsSource = readFileSync(resolve(import.meta.dir, '..', 'Settings.tsx'), 'utf8');

describe('Settings > Viewport grid projection', () => {
  it('reads and displays the live grid preference', () => {
    expect(settingsSource).toContain('const prefs = useViewportPreferences();');
    expect(settingsSource).toContain('label="Show grid"');
    expect(settingsSource).toContain('checked={prefs.gridVisible}');
  });

  it('dispatches the same setViewportPreferences patch without a UI setter', () => {
    expect(settingsSource).toContain('onChange={(gridVisible) => patch({ gridVisible })}');
    expect(settingsSource).toContain("kind: 'setViewportPreferences'");
    expect(settingsSource).not.toMatch(/import[^\n]*store\//u);
    expect(settingsSource).not.toMatch(/\bsetGridVisible\s*\(/u);
    expect(settingsSource).not.toContain("kind: 'toggleGrid'");
  });
});
