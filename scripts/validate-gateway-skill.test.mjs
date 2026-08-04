#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const script = join(dirname(fileURLToPath(import.meta.url)), 'validate-gateway-skill.mjs');
const temp = mkdtempSync(join(tmpdir(), 'gateway-skill-test-'));
const fixture = join(temp, 'forgeax-editor-gateway');
mkdirSync(fixture, { recursive: true });
let failures = 0;

const validBody = [
  '# forgeax-editor-gateway',
  'Start gateway.mjs with --help, then help <operation-kind>.',
  'Discovery comes from gateway.listOps and argsSchema.',
  'Use dispatch for writes and query({with:[]}) for reads.',
  'Branch on error.code.',
  'Use gateway-fresh-page.mjs for a new page.',
  'FORGEAX_BRIDGE is loopback-only at 127.0.0.1.',
].join('\n');

scenario('valid discovery-first skill', skill(validBody), 0);
scenario('missing frontmatter', validBody, 1, 'frontmatter');
scenario('missing name', `---\ndescription: missing name\n---\n${validBody}`, 1, 'name');
scenario('wrong name', `---\nname: other\n---\n${validBody}`, 1, 'forgeax-editor-gateway');
scenario('missing discovery anchor', skill(validBody.replace('argsSchema', 'schema')), 1, 'argsSchema');
scenario('over 300 lines', skill(`${validBody}\n${Array(295).fill('padding').join('\n')}`), 1, 'maximum is 300');

const empty = join(temp, 'empty');
mkdirSync(empty);
const missing = run(empty);
check('missing file', missing.status === 1 && /not found/i.test(missing.stderr));

rmSync(temp, { recursive: true, force: true });
if (failures > 0) process.exit(1);
console.log('[validate-gateway-skill.test] 7/7 passed');

function skill(body) {
  return `---\nname: forgeax-editor-gateway\ndescription: Discovery-first Gateway skill\n---\n${body}`;
}

function scenario(name, content, status, stderrText) {
  writeFileSync(join(fixture, 'SKILL.md'), content);
  const result = run(fixture);
  check(name, result.status === status && (stderrText === undefined || result.stderr.includes(stderrText)));
}

function run(directory) {
  if (!existsSync(script)) return { status: null, stderr: 'validator missing' };
  const result = spawnSync(process.execPath, [script, directory], { encoding: 'utf8', timeout: 5000 });
  return { status: result.status, stderr: result.stderr ?? '' };
}

function check(name, passed) {
  if (passed) console.log(`PASS: ${name}`);
  else {
    console.error(`FAIL: ${name}`);
    failures += 1;
  }
}
