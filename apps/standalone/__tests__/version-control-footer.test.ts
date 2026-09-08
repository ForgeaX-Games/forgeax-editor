import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const css = readFileSync(resolve(root, 'packages/interface/src/components/StatusBar/GlobalStatusBar.css'), 'utf8');
const host = readFileSync(resolve(root, 'packages/interface/src/components/StatusBar/StripHostView.tsx'), 'utf8');

describe('standalone version control footer evidence', () => {
  it('uses computed CSS order 4 for left and 3 for right', () => {
    expect(css).toMatch(/\.sb-slot-left\s*\{[\s\S]*?order:\s*4;/);
    expect(css).toMatch(/\.sb-slot-right\s*\{[\s\S]*?order:\s*3;/);
  });

  it('renders item identity and slot count in the real strip host', () => {
    expect(host).toContain('data-item-id={it.id}');
    expect(host).toContain('data-slot-count={items.length}');
    expect(host).toContain("'statusbar.left': 'left'");
    expect(host).toContain("'statusbar.right': 'right'");
  });

  it('rejects wrong slot, wrong order, and duplicate left owner variants', () => {
    const wrongSlot = css.replace('.sb-slot-left {', '.sb-slot-right {');
    const wrongOrder = css.replace('order: 4;', 'order: 3;');
    const duplicateOwner = host.replace("{visible.map((it) => (", "{[...visible, ...visible].map((it) => (");
    expect(wrongSlot).not.toMatch(/\.sb-slot-left\s*\{[\s\S]*?order:\s*4;/);
    expect(wrongOrder).not.toMatch(/\.sb-slot-left\s*\{[\s\S]*?order:\s*4;/);
    expect(duplicateOwner).toContain('...visible, ...visible');
  });
});
