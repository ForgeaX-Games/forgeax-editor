#!/usr/bin/env node
// Structural gate for the forgeax-editor-gateway entry skill.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skillDir = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(repoRoot, 'skills', 'forgeax-editor-gateway');
const skillFile = join(skillDir, 'SKILL.md');
const expectedName = 'forgeax-editor-gateway';
const maxLines = 300;

// The skill teaches discovery, not a duplicated API catalog. Operation-specific
// names and schemas belong to runtime listOps()/help output.
const requiredAnchors = [
  'gateway.mjs',
  'gateway-fresh-page.mjs',
  '--help',
  'help <operation-kind>',
  'listOps',
  'argsSchema',
  'dispatch',
  'query({with:',
  'error.code',
  'FORGEAX_BRIDGE',
  '127.0.0.1',
];

if (!existsSync(skillFile)) fail(`MISSING: SKILL.md not found at ${skillFile}`);

const raw = readFileSync(skillFile, 'utf8');
const lines = raw.split('\n');
if (lines.length > maxLines) {
  fail(`INVALID: SKILL.md has ${lines.length} lines; maximum is ${maxLines}`);
}

if (lines[0]?.trim() !== '---') fail('INVALID: missing or malformed YAML frontmatter');
const closing = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
if (closing < 0) fail('INVALID: missing or malformed YAML frontmatter');
const frontmatter = lines.slice(1, closing).join('\n');
if (frontmatter.trim() === '') fail('INVALID: frontmatter is empty (no fields)');
const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim();
if (name === undefined) fail('INVALID: frontmatter missing required "name" field');
if (name !== expectedName) {
  fail(`INVALID: frontmatter name must be "${expectedName}", got "${name}"`);
}

const body = lines.slice(closing + 1).join('\n').toLowerCase();
const missing = requiredAnchors.filter((anchor) => !body.includes(anchor.toLowerCase()));
if (missing.length > 0) {
  fail(`INVALID: missing discovery anchor(s): ${missing.join(', ')}`);
}

console.log(
  `[validate-gateway-skill] OK -- ${lines.length}/${maxLines} lines, valid frontmatter, discovery anchors present`,
);

function fail(message) {
  console.error(`[validate-gateway-skill] ${message}`);
  process.exit(1);
}
