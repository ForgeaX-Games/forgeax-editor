import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const viewportPanel = readFileSync(resolve(import.meta.dir, '..', 'ViewportPanel.tsx'), 'utf8');

function viewMenuSource(): string {
  const start = viewportPanel.indexOf('function ViewMenuControl(): ReactNode {');
  const end = viewportPanel.indexOf('function LayoutMenuControl(): ReactNode {');
  return viewportPanel.slice(start, end);
}

describe('ViewportPanel View > Grid projection', () => {
  it('reads the live preference and projects a checked Grid toggle', () => {
    const source = viewMenuSource();

    expect(source).toContain('const prefs = useViewportPreferences();');
    expect(source).toContain("label={pickText(L('Grid', 'Grid'), locale)}");
    expect(source).toContain('checked={prefs.gridVisible}');
  });

  it('dispatches the existing preference patch and never owns a grid action', () => {
    const source = viewMenuSource();

    expect(source).toContain('onChange={(gridVisible) => patchViewportPreferences({ gridVisible })}');
    expect(viewportPanel).toContain("kind: 'setViewportPreferences'");
    expect(viewportPanel).not.toContain("kind: 'toggleGrid'");
    expect(viewportPanel).not.toMatch(/\bworld\.set\s*\(/u);
    expect(viewportPanel).not.toMatch(/import[^\n]*store\//u);
  });
});
