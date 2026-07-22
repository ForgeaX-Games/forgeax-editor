#!/usr/bin/env node
// Full-tree keyboard gate (M5). Editor command execution has one global entry:
// interface/src/lib/global-shortcuts.ts. JSX onKeyDown remains valid because it
// is scoped to a focused modal/control. The two shortcut-forwarder files are
// exact iframe transport exceptions; they forward events and must not mutate
// gateway/store state.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const label = '[lint-single-keydown-router]';
const allowed = new Set([
  'packages/interface/src/lib/global-shortcuts.ts',
  'packages/core/src/shortcut-forwarder.ts',
  'packages/play-runtime/src/shortcut-forwarder.ts',
]);
const globalKeydown = /\b(?:window|document)\s*\.addEventListener\(\s*['"]keydown['"]/;
const files = (await new Promise((resolveFiles) => {
  import('node:child_process').then(({ execFile }) => execFile('rg', ['--files', 'packages', 'standalone'], { cwd: root, encoding: 'utf8' }, (_error, stdout) => resolveFiles(stdout.split('\n').filter(Boolean))));
}));
const offenders = [];

for (const file of files) {
  if (!/\.(?:ts|tsx|js|jsx)$/.test(file)) continue;
  if (file.includes('packages/engine/')) continue;
  if (/(?:__tests__|\.test\.)/.test(file)) continue;
  if (allowed.has(file)) continue;
  const lines = readFileSync(resolve(root, file), 'utf8').split('\n');
  lines.forEach((line, index) => {
    if (globalKeydown.test(line) && !/^\s*(?:\/\/|\*|\/\*)/.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
  });
}

if (offenders.length) {
  console.error(`${label} G-1 violation: found ${offenders.length} global keydown executor(s).`);
  for (const offender of offenders) console.error(`  ${offender}`);
  console.error(`${label} Move editor commands to packages/interface/src/lib/global-shortcuts.ts; move modal Escape/Enter to the modal root onKeyDown. Only exact shortcut-forwarder.ts files may remain as transport exceptions.`);
  process.exit(1);
}
console.log(`${label} AC-A1 OK -- one command executor and only exact transport exceptions`);
