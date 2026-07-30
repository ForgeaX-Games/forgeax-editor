#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const repoRoot = process.cwd();
const symbols = /\b(?:notifyDocChanged|subscribeDocVersion)\b/;
const scanRoots = [
  'packages/core/src',
  'packages/content-browser/src',
  'packages/edit-runtime/src/viewport',
  'packages/panels/src',
  'src',
];
const classification = new Map([
  ['authored-only', new Set([
    'packages/core/src/scene/spawn-asset-ref.ts',
    'packages/core/src/store/doc-version.ts',
    'packages/core/src/store/persistence/disk-io.ts',
    'packages/core/src/store/scene-persistence.ts',
    'packages/panels/src/Hierarchy.tsx',
  ])],
  ['migration-complete', new Set([
    'packages/core/src/index.ts',
    'packages/core/src/store/store.ts',
    'packages/edit-runtime/src/viewport/ViewportComponent.tsx',
  ])],
]);
const runtimeCallChain = new Set([
  'packages/edit-runtime/src/viewport/host-session.ts',
  'packages/edit-runtime/src/viewport/run-lifecycle.ts',
  'packages/edit-runtime/src/viewport/play-assemble.ts',
]);

function walk(root) {
  const files = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    const info = statSync(full);
    if (info.isDirectory()) {
      if (entry !== '__tests__' && entry !== 'node_modules') files.push(...walk(full));
    } else if (/\.(?:mjs|ts|tsx)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

function repoPath(file) {
  return relative(repoRoot, file).split(sep).join('/');
}

function classify(file) {
  const path = repoPath(file);
  for (const [label, paths] of classification) {
    if (paths.has(path)) return label;
  }
  return undefined;
}

const matches = [];
for (const root of scanRoots) {
  const absoluteRoot = join(repoRoot, root);
  for (const file of walk(absoluteRoot)) {
    const path = repoPath(file);
    if (path === 'scripts/check-runtime-broadcast-cutover.mjs') continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, index) => {
      if (symbols.test(text)) matches.push({ path, line: index + 1, text: text.trim() });
    });
  }
}

const blocked = [];
const unclassified = [];
console.log('Runtime broadcast cutover audit');
for (const match of matches) {
  if (runtimeCallChain.has(match.path)) {
    blocked.push(match);
    console.log(`[blocked:runtime-call-chain] ${match.path}:${match.line} ${match.text}`);
    continue;
  }
  const label = classify(match.path);
  if (!label) {
    unclassified.push(match);
    console.log(`[blocked:unclassified] ${match.path}:${match.line} ${match.text}`);
    continue;
  }
  console.log(`[${label}] ${match.path}:${match.line} ${match.text}`);
}

if (blocked.length > 0 || unclassified.length > 0) {
  console.error('CUTOVER BLOCKED: an unclassified or runtime call-chain reference remains.');
  console.error('Rollback gate: keep M6/M7 closed and restore the last consumer migration before retrying.');
  process.exitCode = 1;
} else {
  console.log(`Audit passed: ${matches.length} remaining references are classified.`);
}
