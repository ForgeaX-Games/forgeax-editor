/**
 * AC-01: AppMode structure assertion.
 *
 * 2x2 redesign: AppMode keeps 'edit' (now the run x display viewport workspace)
 * and drops 'preview' (and never adds a separate 'viewport' mode — the viewport
 * lives inside 'edit'). Retains 'bus' for backward compatibility. Also verifies
 * both copies of store.ts are consistent.
 *
 * This test reads the type definition from the source file directly.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', '..');
const IFACE_STORE = resolve(ROOT, 'store.ts');

function readAppModeLine(filePath: string): string {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  for (const line of lines) {
    if (line.includes('export type AppMode')) {
      return line;
    }
  }
  return '';
}

describe('AC-01 AppMode structure assertion', () => {
  it("AppMode in interface/src/store.ts includes 'edit'", () => {
    const line = readAppModeLine(IFACE_STORE);
    expect(line).toContain("'edit'");
  });

  it("AppMode in interface/src/store.ts does NOT include 'preview'", () => {
    const line = readAppModeLine(IFACE_STORE);
    expect(line).not.toContain("'preview'");
  });

  it("AppMode in interface/src/store.ts does NOT include a separate 'viewport' mode", () => {
    const line = readAppModeLine(IFACE_STORE);
    expect(line).not.toContain("'viewport'");
  });

  it("AppMode in interface/src/store.ts retains 'bus' for backward compatibility", () => {
    const line = readAppModeLine(IFACE_STORE);
    expect(line).toContain("'bus'");
  });

  it('both copies of store.ts have matching AppMode definitions', () => {
    const ifaceLine = readAppModeLine(IFACE_STORE);
    const editorIfaceStore = resolve(
      ROOT,
      '..',
      '..',
      'editor',
      'packages',
      'interface',
      'src',
      'store.ts',
    );
    const editorLine = readAppModeLine(editorIfaceStore);
    expect(ifaceLine).toBe(editorLine);
  });
});
