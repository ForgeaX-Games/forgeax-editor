// lint-sync-channel-panels.test.mjs (M2 / w6 red-first TDD anchor)
//
// Drives w7 to green. The lint script under test compares two physical
// arrays:
//   * SSOT — packages/editor-shared/src/manifest.ts EDITOR_PANELS
//   * inline — packages/editor-core/src/sync-channel.ts inline 8-panel
//     literal (kept inline to avoid the shared->core dep cycle, locked by
//     plan-strategy §2 D-2)
//
// The script exits 0 when the two arrays are byte-identical (order
// sensitive) and exits non-zero with a readable stderr diff otherwise.
//
// Coverage:
//   (a) happy:  real repo files agree -> exit 0, stderr clean.
//   (b) drift:  inline reordered     -> exit non-zero, stderr lists the
//               specific add/remove/order-change diff with panel id
//               literals.
//   (c) drift:  inline element added -> exit non-zero, stderr names the
//               extra panel id.
//
// AC anchors:
//   AC-02 (lint script ordering-sensitive comparison)
// Plan anchors:
//   §2 D-2 (inline locked, lint backstop)
//   §2 D-10 (script lives at packages/editor/scripts/)
//   §5.3 must-have test row 3

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EDITOR_ROOT = resolve(__dirname, '..');
const SCRIPT = resolve(__dirname, 'lint-sync-channel-panels.mjs');
const REAL_SHARED = resolve(EDITOR_ROOT, 'packages/editor-shared/src/manifest.ts');
const REAL_CORE = resolve(EDITOR_ROOT, 'packages/editor-core/src/sync-channel.ts');

function runScript(args = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: EDITOR_ROOT,
    encoding: 'utf8',
  });
}

function makeFixturePair(sharedPanels, corePanels) {
  const dir = mkdtempSync(join(tmpdir(), 'lint-sync-fix-'));
  const sharedPath = join(dir, 'manifest.ts');
  const corePath = join(dir, 'sync-channel.ts');
  writeFileSync(
    sharedPath,
    `export const EDITOR_PANELS = [\n${sharedPanels.map((p) => `  '${p}',`).join('\n')}\n] as const;\n`,
  );
  writeFileSync(
    corePath,
    `// inline copy lives here\nconst EDITOR_PANELS = [\n${corePanels.map((p) => `  '${p}',`).join('\n')}\n] as const;\n`,
  );
  return { dir, sharedPath, corePath };
}

describe('lint-sync-channel-panels: happy path (real repo files)', () => {
  test('exits 0 when SSOT and inline agree', () => {
    const r = runScript();
    expect(r.status).toBe(0);
  });
  test('stderr is clean on happy path', () => {
    const r = runScript();
    expect(r.stderr).toBe('');
  });
});

describe('lint-sync-channel-panels: drift detection', () => {
  test('exits non-zero when inline reordered', () => {
    const reordered = [
      'inspector', // swap with hierarchy
      'hierarchy',
      'assets',
      'history',
      'capabilities',
      'material',
      'timeline',
      'matgraph',
    ];
    const ssot = [
      'hierarchy',
      'inspector',
      'assets',
      'history',
      'capabilities',
      'material',
      'timeline',
      'matgraph',
    ];
    const fix = makeFixturePair(ssot, reordered);
    try {
      const r = runScript(['--shared-path', fix.sharedPath, '--core-path', fix.corePath]);
      expect(r.status).not.toBe(0);
      // Diff must name the specific panel literals that disagree.
      expect(r.stderr).toContain('hierarchy');
      expect(r.stderr).toContain('inspector');
    } finally {
      rmSync(fix.dir, { recursive: true, force: true });
    }
  });

  test('exits non-zero when inline has an extra panel', () => {
    const ssot = ['hierarchy', 'inspector'];
    const inline = ['hierarchy', 'inspector', 'phantom'];
    const fix = makeFixturePair(ssot, inline);
    try {
      const r = runScript(['--shared-path', fix.sharedPath, '--core-path', fix.corePath]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('phantom');
    } finally {
      rmSync(fix.dir, { recursive: true, force: true });
    }
  });

  test('exits non-zero when inline drops a panel', () => {
    const ssot = ['hierarchy', 'inspector', 'assets'];
    const inline = ['hierarchy', 'inspector'];
    const fix = makeFixturePair(ssot, inline);
    try {
      const r = runScript(['--shared-path', fix.sharedPath, '--core-path', fix.corePath]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('assets');
    } finally {
      rmSync(fix.dir, { recursive: true, force: true });
    }
  });
});

describe('lint-sync-channel-panels: byte-level sanity (real repo)', () => {
  test('SSOT and inline arrays parse to identical sequences', () => {
    // Independent sanity check that mirrors the script's own comparison —
    // if this ever diverges, w7 (and the inline locked by plan §2 D-2)
    // need a real fix, not a lint relax.
    const sharedSrc = readFileSync(REAL_SHARED, 'utf8');
    const coreSrc = readFileSync(REAL_CORE, 'utf8');
    const extract = (src) => {
      const m = src.match(/EDITOR_PANELS\s*=\s*\[([\s\S]*?)\]\s*as\s+const/);
      if (!m) throw new Error('EDITOR_PANELS literal not found');
      return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    };
    expect(extract(sharedSrc)).toEqual(extract(coreSrc));
  });
});
