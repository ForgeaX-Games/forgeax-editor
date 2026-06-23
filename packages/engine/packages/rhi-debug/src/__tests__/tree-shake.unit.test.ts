// m3-3: tree-shake grep gate — verify FORGEAX_ENGINE_RHI_DEBUG=0 bundle does NOT
// contain 'engine-rhi-debug' string (AC-03).
//
// This test uses a static grep on dist bundles. When no dist bundles exist
// (cold worktree), the test skips with a descriptive reason; CI runs with
// the full build chain produce real coverage.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function findDistMjsFiles(rootDir: string): string[] {
  const results: string[] = [];
  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules') continue;
        walk(full);
      } else if (e.name.endsWith('.mjs') && full.includes('/dist/assets/')) {
        results.push(full);
      }
    }
  }
  walk(rootDir);
  return results;
}

// I-14 fix-up (round 1 implement-review): the prior shape silently
// `return`ed when no dist bundles existed (cold worktree), making the
// gate look green every time without a real grep. We now compute the
// dist file list at module load time and use `it.skipIf(...)` so the
// test skip is explicit and visible in the test report rather than
// disguised as a passed assertion (memory: empty-baseline-and-empty-
// frame-falsely-pass-smoke same anti-pattern).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const DIST_FILES = findDistMjsFiles(ENGINE_ROOT);

describe('tree-shake grep gate (AC-03)', () => {
  it.skipIf(DIST_FILES.length === 0)(
    'FORGEAX_ENGINE_RHI_DEBUG=0 dist bundles do not contain engine-rhi-debug string',
    () => {
      // Grep each .mjs file for the forbidden string.
      const violations: string[] = [];
      for (const fp of DIST_FILES) {
        let content: string;
        try {
          content = fs.readFileSync(fp, 'utf-8');
        } catch {
          continue;
        }
        if (content.includes('engine-rhi-debug')) {
          violations.push(fp);
        }
      }

      // All demo dist bundles must be clean.
      expect(violations).toEqual([]);
    },
  );
});
