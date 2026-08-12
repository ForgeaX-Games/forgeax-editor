#!/usr/bin/env node
// lint-fx-no-studio-port.test.mjs — falsification self-test for the fx-no-studio-port
// gate. Proves the gate has discriminating power:
//   (a) fixed fx (editor-owned ports, no Studio ports)                  → exit 0
//   (b) 15173 back in the PORTS kill-set                           → exit 1 (the bug)
//   (c) FORGEAX_ENGINE_PORT: '15173' launch env                    → exit 1 (the bug)
//   (d) comments mentioning Studio ports (explaining the decoupling) → exit 0
//   (e) PORTS anchor renamed/removed                               → exit 2 (refuse to pass blind)
//   (f) the REAL scripts/fx.ts (no --file)                         → exit 0 (installer stays correct)
//
// NOTE: colocated *.test.mjs are dev-time harnesses — they are NOT run in CI
// `bun run test:scripts` invokes this falsification test; CI enforcement is
// lint-fx-no-studio-port.mjs via `bun run lint`. Run it manually with:
//   node scripts/__tests__/lint-fx-no-studio-port.test.mjs
//
// Exits: 0 all scenarios pass, 1 at least one failed.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LINT_SCRIPT = join(__dirname, '..', 'lint-fx-no-studio-port.mjs');

let failures = 0;
let total = 0;

function assertEqual(desc, actual, expected) {
  total++;
  if (actual === expected) {
    console.log(`  PASS: ${desc}`);
  } else {
    failures++;
    console.error(`  FAIL: ${desc} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function runLint(filePath) {
  const r = spawnSync(process.execPath, [LINT_SCRIPT, '--file', filePath], {
    encoding: 'utf8',
    timeout: 5000,
  });
  return r.status;
}

// Minimal synthetic fx bodies. The gate keys on the `const PORTS = [ ... ]` anchor,
// launch values, and Studio's gateway port, ignoring comments.
const FIXED = `
const PLAY_RUNTIME_PORT = 15273;
const EDITOR_BRIDGE_PORT = 15296;
const PORTS = [15290, 15280, 15281, PLAY_RUNTIME_PORT];
const env = { ...process.env, FORGEAX_ENGINE_PORT: String(PLAY_RUNTIME_PORT) };
spawnService('bun', ['-F', '@forgeax/editor-play-runtime', 'dev'], { cwd: ROOT, env });
`;

const PORTS_HAS_15173 = `
const PORTS = [15290, 15280, 15281, 15173];
const env = { ...process.env, FORGEAX_ENGINE_PORT: String(PLAY_RUNTIME_PORT) };
`;

const LAUNCH_15173 = `
const PLAY_RUNTIME_PORT = 15273;
const PORTS = [15290, 15280, 15281, PLAY_RUNTIME_PORT];
spawnService('bun', ['-F', '@forgeax/editor-play-runtime', 'dev'], { cwd: ROOT, env: { ...env, FORGEAX_ENGINE_PORT: '15173' } });
`;

// Comments that mention Studio ports to explain the decoupling must NOT trip the gate.
const COMMENT_MENTIONS_15173 = `
// Deliberately NOT 15173: studio owns that port. See the feedback note.
// Studio's gateway is 15295; the editor uses a separate relay.
const PLAY_RUNTIME_PORT = 15273;
const EDITOR_BRIDGE_PORT = 15296;
const PORTS = [15290, 15280, 15281, PLAY_RUNTIME_PORT];
/* block comment: 15173 is studio's PORT_ENGINE default; we stay off it. */
const env = { ...process.env, FORGEAX_ENGINE_PORT: String(PLAY_RUNTIME_PORT) };
`;

const GATEWAY_15295 = `
const EDITOR_BRIDGE_PORT = 15295;
const PORTS = [15290, 15280, 15281, 15273];
`;

// PORTS anchor removed — the gate must refuse to pass blind (exit 2).
const NO_PORTS_ANCHOR = `
const MANAGED = [15290, 15280, 15281, 15273, 15295];
`;

const tmpDir = mkdtempSync(join(tmpdir(), 'fx-no-studio-port-test-'));
console.log('lint-fx-no-studio-port.test.mjs — falsification self-test');
console.log(`Temp dir: ${tmpDir}\n`);

const fixedPath = join(tmpDir, 'fixed.ts');
const portsBadPath = join(tmpDir, 'ports-bad.ts');
const launchBadPath = join(tmpDir, 'launch-bad.ts');
const commentPath = join(tmpDir, 'comment-ok.ts');
const gatewayBadPath = join(tmpDir, 'gateway-bad.ts');
const noAnchorPath = join(tmpDir, 'no-anchor.ts');
writeFileSync(fixedPath, FIXED);
writeFileSync(portsBadPath, PORTS_HAS_15173);
writeFileSync(launchBadPath, LAUNCH_15173);
writeFileSync(commentPath, COMMENT_MENTIONS_15173);
writeFileSync(gatewayBadPath, GATEWAY_15295);
writeFileSync(noAnchorPath, NO_PORTS_ANCHOR);

console.log('Scenario (a): fixed fx (editor-owned ports) — expect exit 0');
assertEqual('(a) fixed → 0', runLint(fixedPath), 0);

console.log('Scenario (b): 15173 back in PORTS kill-set — expect exit 1');
assertEqual('(b) 15173 in PORTS → 1', runLint(portsBadPath), 1);

console.log("Scenario (c): FORGEAX_ENGINE_PORT: '15173' launch env — expect exit 1");
assertEqual('(c) launch on 15173 → 1', runLint(launchBadPath), 1);

console.log('Scenario (d): comment mentions 15173 (decoupling note) — expect exit 0');
assertEqual('(d) comment-only 15173 → 0', runLint(commentPath), 0);

console.log('Scenario (e): editor gateway on Studio :15295 — expect exit 1');
assertEqual('(e) Studio gateway 15295 → 1', runLint(gatewayBadPath), 1);

console.log('Scenario (f): PORTS anchor removed — expect exit 2');
assertEqual('(f) no PORTS anchor → 2', runLint(noAnchorPath), 2);

console.log('Scenario (g): real scripts/fx.ts (default target) — expect exit 0');
{
  total++;
  const r = spawnSync(process.execPath, [LINT_SCRIPT], { encoding: 'utf8', timeout: 5000 });
  if (r.status === 0) {
    console.log('  PASS: (g) real fx.ts → 0');
  } else {
    failures++;
    console.error(`  FAIL: (g) real fx.ts → expected 0, got ${JSON.stringify(r.status)}\n${r.stderr}`);
  }
}

rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${'='.repeat(60)}`);
console.log(`Results: ${total - failures}/${total} passed`);
if (failures > 0) {
  console.error(`FAILURES: ${failures} scenario(s) failed`);
  process.exit(1);
}
console.log('All scenarios passed — gate has discriminating power');
process.exit(0);
