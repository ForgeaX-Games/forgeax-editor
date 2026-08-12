import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../..', import.meta.url);
const lint = fileURLToPath(new URL('../lint-gameplay-carrier-boundary.mjs', import.meta.url));

function run(file) {
  try {
    execFileSync(process.execPath, [lint, '--file', file], { encoding: 'utf8', stdio: 'pipe' });
    return 0;
  } catch (error) {
    return error.status ?? 2;
  }
}

const fixtureDir = mkdtempSync(join(tmpdir(), 'forgeax-gameplay-boundary-'));
const valid = join(fixtureDir, 'valid.tsx');
const invalid = join(fixtureDir, 'invalid.tsx');
writeFileSync(valid, 'createGameplayCarrierBridge();\n');
writeFileSync(invalid, 'createGameplayCarrierBridge();\n__forgeax_editor = { dispatchGameplayInput };\n');

if (run(valid) !== 0 || run(invalid) !== 1) {
  console.error('lint-gameplay-carrier-boundary falsification failed');
  process.exit(1);
}

const actual = fileURLToPath(new URL('./packages/edit-runtime/src/viewport/ViewportComponent.tsx', root));
if (run(actual) !== 0) {
  console.error('lint-gameplay-carrier-boundary rejects the live producer unexpectedly');
  process.exit(1);
}

console.log('lint-gameplay-carrier-boundary.test.mjs — private transport is rejected');
