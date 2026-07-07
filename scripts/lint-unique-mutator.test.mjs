#!/usr/bin/env node
// lint-unique-mutator.test.mjs -- Gate A falsification self-test
// (feat-20260707-editor-trace-ioc M3 t14, plan-strategy §5.1).
//
// TDD: fixture scenarios validate the gate has discriminating power:
//   (a) VIOLATION diff (new raw world.set in editor source) → exit 1
//   (b) COMPLIANT diff (write through ctx.engine / gateway.dispatch) → exit 0
//   (c) FACADE diff (raw world.set inside engine-facade.ts, the gate body) → exit 0
//   (d) OOS-10 diff (raw world.set inside action-bridge.ts) → exit 0 (excluded)
//   (e) TEST-HUNK diff (raw world.set in __tests__/) → exit 0
//   (f) CAST diff (cast-receiver `).set(` on a world token) → exit 1
//   (g) CLEAN diff (no world writes) → exit 0
//
// Usage: node scripts/lint-unique-mutator.test.mjs
// Exits: 0 all pass, 1 at least one scenario failed

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LINT_SCRIPT = join(__dirname, 'lint-unique-mutator.mjs');

let failures = 0;
let total = 0;

function assertEqual(desc, actual, expected) {
  total++;
  if (actual !== expected) {
    failures++;
    console.error(`  FAIL: ${desc} -- expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else {
    console.log(`  PASS: ${desc}`);
  }
}

function makeDiff(hunks) {
  const parts = [];
  for (const h of hunks) {
    parts.push(`diff --git a/${h.file} b/${h.file}`);
    parts.push('new file mode 100644');
    parts.push('index 0000000..0000000');
    parts.push('--- /dev/null');
    parts.push(`+++ b/${h.file}`);
    parts.push(`@@ -0,0 +1,${h.lines.length} @@`);
    for (const line of h.lines) parts.push(`+${line}`);
  }
  return parts.join('\n');
}

function runLint(diffPath) {
  if (!existsSync(LINT_SCRIPT)) {
    return { status: null, stderr: 'lint-unique-mutator.mjs not found (TDD red phase)' };
  }
  const r = spawnSync(process.execPath, [LINT_SCRIPT, '--diff-file', diffPath], { encoding: 'utf8', timeout: 5000 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const tmpDir = mkdtempSync(join(tmpdir(), 'gate-a-test-'));
const diffDir = join(tmpDir, 'diffs');
mkdirSync(diffDir, { recursive: true });

console.log('lint-unique-mutator.test.mjs -- Gate A falsification TDD');
console.log(`Temp dir: ${tmpDir}\n`);

const write = (name, hunks) => {
  const p = join(diffDir, name);
  writeFileSync(p, makeDiff(hunks));
  return p;
};

// (a) VIOLATION: new raw world.set in editor source
console.log('Scenario (a): VIOLATION -- raw world.set in edit-runtime source → exit 1');
assertEqual('(a) exit 1', runLint(write('viol.diff', [{
  file: 'packages/edit-runtime/src/engine/viewport.ts',
  lines: ['  world.set(camera, Transform, { posX: 0 });'],
}])).status, 1);

// (b) COMPLIANT: write through ctx.engine + gateway.dispatch
console.log('Scenario (b): COMPLIANT -- engine.set / gateway.dispatch → exit 0');
assertEqual('(b) exit 0', runLint(write('comp.diff', [{
  file: 'packages/edit-runtime/src/engine/viewport.ts',
  lines: [
    '  engine.set(camera, Transform, { posX: 0 });',
    "  gateway.dispatch({ kind: 'spawnEntity', components: {} });",
  ],
}])).status, 0);

// (c) FACADE: raw world.set inside the gate body itself
console.log('Scenario (c): FACADE gate body -- raw world.set in engine-facade.ts → exit 0');
assertEqual('(c) exit 0', runLint(write('facade.diff', [{
  file: 'packages/core/src/io/engine-facade.ts',
  lines: ['    return this._world.set(entity, component, data);', '    world.spawn(x);'],
}])).status, 0);

// (d) OOS-10: raw world.set inside action-bridge.ts (registry projection)
console.log('Scenario (d): OOS-10 registry -- raw world.set in action-bridge.ts → exit 0');
assertEqual('(d) exit 0', runLint(write('oos10.diff', [{
  file: 'packages/core/src/io/action-bridge.ts',
  lines: ['  world.set(entity, Comp, patch);'],
}])).status, 0);

// (e) TEST-HUNK
console.log('Scenario (e): TEST-HUNK -- raw world.set in __tests__/ → exit 0');
assertEqual('(e) exit 0', runLint(write('test.diff', [{
  file: 'packages/core/src/__tests__/foo.test.ts',
  lines: ['  world.set(e, C, {});'],
}])).status, 0);

// (f) CAST-receiver form
console.log('Scenario (f): CAST -- (world as never as {...}).set( → exit 1');
assertEqual('(f) exit 1', runLint(write('cast.diff', [{
  file: 'packages/edit-runtime/src/host-boot.ts',
  lines: ['    (world as never as { set: (e, c, d) => unknown }).set(root, TransformC, {});'],
}])).status, 1);

// (g) CLEAN
console.log('Scenario (g): CLEAN -- no world writes → exit 0');
assertEqual('(g) exit 0', runLint(write('clean.diff', [{
  file: 'packages/core/src/io/catalog.ts',
  lines: ['  // just a comment', '  const x = 1;'],
}])).status, 0);

// (h) COMMENT-only raw write reference → exit 0
console.log('Scenario (h): COMMENT -- world.allocSharedRef in a doc comment → exit 0');
assertEqual('(h) exit 0', runLint(write('comment.diff', [{
  file: 'packages/edit-runtime/src/engine/skylight.ts',
  lines: ['  // column handle via world.allocSharedRef(brand, pod).'],
}])).status, 0);

rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${'='.repeat(60)}`);
console.log(`Results: ${total - failures}/${total} passed`);
if (failures > 0) {
  console.error(`FAILURES: ${failures} scenarios failed`);
  process.exit(1);
}
console.log('All falsification scenarios passed -- Gate A has discriminating power');
process.exit(0);
