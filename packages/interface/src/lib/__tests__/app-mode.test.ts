/**
 * AC-01: AppMode structure assertion.
 *
 * 2x2 redesign: AppMode keeps the scene workbench mode (now the run x display
 * viewport workspace) and drops 'preview' (and never adds a separate 'viewport'
 * mode — the viewport lives inside the scene workbench). Retains 'bus' for
 * backward compatibility.
 *
 * 2026-07-07 (T3): AI workbench mode id renamed 'workbench' → 'ai'.
 * 2026-07-08 (v9): Scene workbench mode id renamed 'edit' → 'scene' (id/name
 *   align). The previously-enforced cross-copy assertion against the nested
 *   editor submodule's `packages/interface/src/store.ts` is not enforced here
 *   — the two interface packages migrate independently.
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
  it("AppMode in interface/src/store.ts includes 'scene' (v9 rename of 'edit')", () => {
    const line = readAppModeLine(IFACE_STORE);
    expect(line).toContain("'scene'");
  });

  it("AppMode in interface/src/store.ts NO LONGER includes 'edit' (v9 rename)", () => {
    const line = readAppModeLine(IFACE_STORE);
    // Match a literal `'edit'` in the union to avoid false positives on
    // substrings — but the union should not contain it at all.
    expect(line).not.toMatch(/'edit'/);
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

  it("AppMode in interface/src/store.ts uses the renamed 'ai' AI workbench mode id (T3)", () => {
    const line = readAppModeLine(IFACE_STORE);
    expect(line).toContain("'ai'");
    // Legacy 'workbench' mode id must not appear in the AppMode union post-T3.
    expect(line).not.toContain("'workbench'");
  });
});
