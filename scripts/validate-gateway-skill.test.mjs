#!/usr/bin/env node
// validate-gateway-skill.test.mjs -- M5 skill content anchor validation TDD
// (feat-20260706-editor-op-gateway-single-entry-b-catalog-defineop, m5-w2).
//
// TDD: written BEFORE validate-gateway-skill.mjs exists.
// Validates that the skill anchor checker correctly detects:
//   (a) VALID fixture -- SKILL.md with frontmatter (name + description) +
//       text covering gateway API plus live-bridge safety anchors -> exit 0
//   (b) MISSING frontmatter -- SKILL.md without frontmatter -> exit 1
//   (c) MISSING name field -- SKILL.md with frontmatter but no name -> exit 1
//   (d) MISSING keyword anchor -- SKILL.md without listOps in content -> exit 1
//   (e) MISSING file -- no SKILL.md at path -> exit 1
//   (f) EMPTY frontmatter -- SKILL.md with frontmatter but empty -> exit 1
//   (g) INCORRECT name -- wrong name value in frontmatter -> exit 1
//
// Usage: node scripts/validate-gateway-skill.test.mjs
// Exits: 0 all pass, 1 at least one scenario failed

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(__dirname, 'validate-gateway-skill.mjs');

let failures = 0;
let total = 0;

function assert(desc, fn) {
  total++;
  try {
    fn();
    console.log(`  PASS: ${desc}`);
    return true;
  } catch (e) {
    failures++;
    console.error(`  FAIL: ${desc} -- ${e.message}`);
    return false;
  }
}

function assertEqual(desc, actual, expected) {
  assert(desc, () => {
    if (actual !== expected) {
      throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  });
}

function runValidator(skillDir) {
  if (!existsSync(SCRIPT_PATH)) {
    // TDD red-phase: script not written yet
    return { status: null, stdout: '', stderr: 'validate-gateway-skill.mjs not found (TDD: implement m5-w4 first)' };
  }
  const result = spawnSync(process.execPath, [SCRIPT_PATH, skillDir], {
    encoding: 'utf8',
    timeout: 5000,
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

// Helper: create a SKILL.md fixture and run the validator
function testFixture(desc, content, expectStatus, expectStderrContains) {
  const skillPath = join(fixtureDir, 'SKILL.md');
  writeFileSync(skillPath, content);
  const result = runValidator(fixtureDir);
  assertEqual(desc + ' exit code', result.status, expectStatus);
  if (expectStderrContains && result.stderr) {
    assert(desc + ' stderr', () => {
      for (const pat of expectStderrContains) {
        if (!result.stderr.includes(pat)) {
          throw new Error(`stderr should contain "${pat}"; got: ${result.stderr.slice(0, 200)}`);
        }
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Setup: temporary directory for fixture SKILL.md files
// ---------------------------------------------------------------------------
const tmpDir = mkdtempSync(join(tmpdir(), 'skill-test-'));
const fixtureDir = join(tmpDir, 'forgeax-editor-gateway');
mkdirSync(fixtureDir, { recursive: true });

console.log('validate-gateway-skill.test.mjs -- M5 skill anchor validation TDD');
console.log(`Temp dir: ${tmpDir}\n`);

// ---------------------------------------------------------------------------
// Scenario (a): VALID fixture -> exit 0
// ---------------------------------------------------------------------------
console.log('Scenario (a): VALID SKILL.md -- expect exit 0');
testFixture('(a) valid fixture', [
  '---',
  'name: forgeax-editor-gateway',
  'description: >-',
  '  All editor operations go through the single EditGateway -- dispatch, begin, commit,',
  '  listOps, and defineOp are the entry points.',
  '---',
  '',
  '# forgeax-editor-gateway',
  '',
  '## Usage: dispatch',
  '',
  'Use `gateway.dispatch(op)` to execute an immediate operation.',
  '',
  '## Usage: begin...commit',
  '',
  'For continuous operations, use `gateway.begin(op)` followed by',
  '`gateway.update(op)` and finally `gateway.commit(op)`.',
  '',
  '## Usage: listOps',
  '',
  'Call `gateway.listOps()` to introspect all available operations.',
  '',
  '## Usage: defineOp',
  '',
  'Use `gateway.defineOp({ id, domain, argsSchema, plan })` to register',
  'a new document-domain operation.',
  '',
  'Use eval in the AI scope and inspect trace output through gateway.trace.',
  'querySnapshot results can be read safely.',
  'Use gateway.collectSceneAsset before an advanced instantiateSceneAsset call.',
  'Use gateway.dispatch({ kind: "duplicateEntity", entity }, "ai") for ordinary copies.',
  'Never mix live worlds with an engine `dist` import.',
  'Use scripts/gateway-live.mjs through FORGEAX_BRIDGE on 127.0.0.1 only.',
// Round-2/3/4 anchors — this fixture must carry every REQUIRED_KEYWORDS entry
  // or scenario (a) fails (it drifted behind rounds 2-4 until round-4 rhi-debug).
  'The undo / redo / canUndo timeline family returns a bare boolean.',
  'Author asset-resident logic in `*.plugin.ts` via defineComponent / defineSystem.',
  'Scoped plans reverse-scan ChildOf to enumerate a parent children.',
  'Dispatch a composed op with top-level args; argsSchema is enforced at dispatch.',
  'RHI frame capture is reached via globalThis.__forgeax.captureFrame — outside the gateway.',
  'Use importAsset to cook a file, then addSceneAssetToScene to place a catalogued scene GUID.',
  'Poll gateway.sceneMountPhase and inspect gateway.lastSceneMountError for a terminal scene mount.',
  'For real Play dogfood boot `bun fx start --game games/sample` — no --game opens an empty scene.',
  'Poll gateway.playPhase to a terminal value; on failed read gateway.lastPlayError.',
  'Follow a material texture GUID with gateway.describeAssetByGuid — not lookupAsset (full buffer).',
].join('\n'), 0, null);

// ---------------------------------------------------------------------------
// Scenario (b): MISSING frontmatter -> exit 1
// ---------------------------------------------------------------------------
console.log('Scenario (b): MISSING frontmatter -- expect exit 1');
testFixture('(b) no frontmatter', [
  '# forgeax-editor-gateway',
  '',
  'This is a gateway skill with dispatch, begin, commit, listOps, and defineOp.',
].join('\n'), 1, ['frontmatter']);

// ---------------------------------------------------------------------------
// Scenario (c): MISSING name field -> exit 1
// ---------------------------------------------------------------------------
console.log('Scenario (c): MISSING name field -- expect exit 1');
testFixture('(c) no name', [
  '---',
  'description: A gateway skill without a name',
  '---',
  '',
  '# forgeax-editor-gateway',
  '',
  'dispatch, begin, commit, listOps, defineOp',
].join('\n'), 1, ['name']);

// ---------------------------------------------------------------------------
// Scenario (d): MISSING keyword anchor (listOps) -> exit 1
// ---------------------------------------------------------------------------
console.log('Scenario (d): MISSING keyword anchor -- expect exit 1');
testFixture('(d) missing listOps', [
  '---',
  'name: forgeax-editor-gateway',
  'description: Gateway skill',
  '---',
  '',
  '# forgeax-editor-gateway',
  '',
  '## Usage: dispatch',
  '',
  'Use dispatch for immediate operations.',
  '',
  '## Usage: begin...commit',
  '',
  'Use begin and commit for continuous operations.',
  '',
  '## Usage: defineOp',
  '',
  'Use defineOp to register new operations.',
].join('\n'), 1, ['listOps']);

// ---------------------------------------------------------------------------
// Scenario (e): MISSING file -> exit 1
// ---------------------------------------------------------------------------
console.log('Scenario (e): MISSING file -- expect exit 1');
const emptyDir = join(tmpDir, 'empty');
mkdirSync(emptyDir, { recursive: true });
const eResult = runValidator(emptyDir);
assertEqual('(e) missing file exit code', eResult.status, 1);
if (eResult.stderr) {
  assert('(e) missing file stderr', () => {
    if (!eResult.stderr.includes('not found') && !eResult.stderr.includes('missing')) {
      throw new Error(`stderr should mention missing file; got: ${eResult.stderr.slice(0, 200)}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Scenario (f): EMPTY frontmatter -> exit 1
// ---------------------------------------------------------------------------
console.log('Scenario (f): EMPTY frontmatter -- expect exit 1');
testFixture('(f) empty frontmatter', [
  '---',
  '---',
  '# forgeax-editor-gateway',
  '',
  'dispatch, begin, commit, listOps, defineOp',
].join('\n'), 1, ['name']);

// ---------------------------------------------------------------------------
// Scenario (g): INCORRECT name value -> exit 1
// ---------------------------------------------------------------------------
console.log('Scenario (g): INCORRECT name value -- expect exit 1');
testFixture('(g) wrong name', [
  '---',
  'name: some-other-skill',
  'description: Not the gateway',
  '---',
  '',
  '# forgeax-editor-gateway',
  '',
  'dispatch, begin, commit, listOps, defineOp',
].join('\n'), 1, ['name', 'forgeax-editor-gateway']);

// ---------------------------------------------------------------------------
// Scenario (h): MISSING live bridge anchor -> exit 1
// ---------------------------------------------------------------------------
console.log('Scenario (h): MISSING live bridge anchor -- expect exit 1');
testFixture('(h) missing gateway-live anchor', [
  '---',
  'name: forgeax-editor-gateway',
  'description: Gateway skill',
  '---',
  '',
  '# forgeax-editor-gateway',
  '',
  'dispatch, begin, commit, listOps, defineOp, eval, scope, trace, querySnapshot',
  'collectSceneAsset, duplicateEntity, and engine `dist` are documented.',
].join('\n'), 1, ['gateway-live.mjs']);

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
rmSync(tmpDir, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(60)}`);
console.log(`Results: ${total - failures}/${total} passed`);
if (failures > 0) {
  console.error(`FAILURES: ${failures} scenarios failed`);
  process.exit(1);
}
console.log('All skill validation scenarios passed');
process.exit(0);