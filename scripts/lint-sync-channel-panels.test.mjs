// lint-sync-channel-panels.test.mjs (M4 / w27 single-SSOT guard)
//
// Drives w27 to green. The lint script under test now guards the
// single-SSOT invariant: EDITOR_PANELS must exist in exactly one file
// (editor-core/src/manifest.ts). Any second copy trips CI.
//
// The script exits 0 when exactly one EDITOR_PANELS literal is found,
// exits 1 when 2+ copies exist (drift), exits 2 when 0 copies are found.
//
// Coverage:
//   (a) happy:  real repo has exactly one EDITOR_PANELS → exit 0.
//   (b) drift:  two files each define EDITOR_PANELS → exit 1, stderr names
//               both files + panel id literals.
//   (c) zero:   no file defines EDITOR_PANELS → exit 2.
//
// AC anchors:
//   AC-07 (lint:sync-channel green after semantic upgrade)
// Plan anchors:
//   plan-strategy S2 D3 (lint upgraded from dual-compare to single-SSOT guard)
//   AGENTS.md invariant #3 (single-SSOT, not dual-copy)

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EDITOR_ROOT = resolve(__dirname, '..');
const SCRIPT = resolve(__dirname, 'lint-sync-channel-panels.mjs');
const REAL_SSOT = resolve(EDITOR_ROOT, 'packages/editor-core/src/manifest.ts');

function runScript(args = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: EDITOR_ROOT,
    encoding: 'utf8',
  });
}

/**
 * Create a temp directory with fixture files for scan-based testing.
 * Each entry in `fileDefs` is { name, panels } or just { name } (no literal).
 */
function makeFixtureDir(fileDefs) {
  const dir = mkdtempSync(join(tmpdir(), 'lint-sync-fix-'));
  for (const def of fileDefs) {
    const content = def.panels
      ? `export const EDITOR_PANELS = [\n${def.panels.map((p) => `  '${p}',`).join('\n')}\n] as const;\n`
      : '// no EDITOR_PANELS here\n';
    writeFileSync(join(dir, def.name), content);
  }
  return dir;
}

describe('lint-sync-channel-panels: single-SSOT happy path (real repo)', () => {
  test('exits 0 when exactly one EDITOR_PANELS literal exists', () => {
    const r = runScript(['--ssoot-path', REAL_SSOT]);
    expect(r.status).toBe(0);
  });
  test('stdout confirms single SSOT', () => {
    const r = runScript(['--ssoot-path', REAL_SSOT]);
    expect(r.stdout).toContain('single SSOT');
  });
});

describe('lint-sync-channel-panels: drift detection', () => {
  test('exits 1 when two files each define EDITOR_PANELS', () => {
    const fix = makeFixtureDir([
      { name: 'manifest.ts', panels: ['hierarchy', 'inspector', 'assets'] },
      { name: 'sync-channel.ts', panels: ['hierarchy', 'inspector', 'assets'] },
    ]);
    try {
      const r = runScript(['--scan-dir', fix]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('drift');
      expect(r.stderr).toContain('2 copies');
    } finally {
      rmSync(fix, { recursive: true, force: true });
    }
  });

  test('exits 1 when panels differ (order or content)', () => {
    const fix = makeFixtureDir([
      { name: 'manifest.ts', panels: ['hierarchy', 'inspector', 'assets'] },
      { name: 'other.ts', panels: ['hierarchy', 'assets', 'inspector'] },
    ]);
    try {
      const r = runScript(['--scan-dir', fix]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('drift');
      expect(r.stderr).toContain('2 copies');
      // Both file paths should appear in stderr.
      expect(r.stderr).toContain('manifest.ts');
      expect(r.stderr).toContain('other.ts');
    } finally {
      rmSync(fix, { recursive: true, force: true });
    }
  });

  test('exits 1 when inline has an extra panel', () => {
    const fix = makeFixtureDir([
      { name: 'manifest.ts', panels: ['hierarchy', 'inspector'] },
      { name: 'other.ts', panels: ['hierarchy', 'inspector', 'phantom'] },
    ]);
    try {
      const r = runScript(['--scan-dir', fix]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('phantom');
    } finally {
      rmSync(fix, { recursive: true, force: true });
    }
  });
});

describe('lint-sync-channel-panels: zero-copy detection', () => {
  test('exits 2 when no file defines EDITOR_PANELS', () => {
    const fix = makeFixtureDir([
      { name: 'foo.ts' },
      { name: 'bar.ts' },
    ]);
    try {
      const r = runScript(['--scan-dir', fix]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('not found');
    } finally {
      rmSync(fix, { recursive: true, force: true });
    }
  });
});

describe('lint-sync-channel-panels: scan-dir isolation', () => {
  test('single copy exits 0 when only one file has EDITOR_PANELS', () => {
    const fix = makeFixtureDir([
      { name: 'manifest.ts', panels: ['hierarchy', 'inspector'] },
      { name: 'helper.ts' },
      { name: 'utils.ts' },
    ]);
    try {
      const r = runScript(['--scan-dir', fix, '--ssoot-path', join(fix, 'manifest.ts')]);
      expect(r.status).toBe(0);
    } finally {
      rmSync(fix, { recursive: true, force: true });
    }
  });
});