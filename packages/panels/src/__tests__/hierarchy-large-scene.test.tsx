import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';

const panel = readFileSync(resolve(import.meta.dir, '..', 'Hierarchy.tsx'), 'utf8');

describe('Hierarchy large-scene viewport', () => {
  it('virtualizes the visible tree while keeping the existing Row gateway path', () => {
    expect(panel).toContain("import { useVirtualizer } from '@tanstack/react-virtual';");
    expect(panel).toContain('data-testid="hierarchy-virtual-rows"');
    expect(panel).toContain('virtualized');
    expect(panel).toContain('renderChildren={false}');
  });

  it('does not let a lagging runtime projection hide freshly authored world entities', () => {
    expect(panel).toContain('projection.rows.length === worldEntityIds.length');
    expect(panel).toContain('flattenVisibleRows(roots, view.collapsed, activeWorld, usableProjection)');
  });

  it('resynchronizes the native scroll offset after a dock resize clamps it', () => {
    expect(panel).toContain('element.scrollHeight - element.clientHeight');
    expect(panel).toContain("element.dispatchEvent(new Event('scroll'))");
  });
});
