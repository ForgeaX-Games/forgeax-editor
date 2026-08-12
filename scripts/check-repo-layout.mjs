#!/usr/bin/env node

import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORBIDDEN_ROOT_ENTRIES = [
  'src',
  'types',
  'test',
  'tests',
  '__tests__',
  '.dependency-cruiser.cjs',
];

export function findRootLayoutViolations(rootEntries) {
  const present = new Set(rootEntries);
  return FORBIDDEN_ROOT_ENTRIES
    .filter((entry) => present.has(entry))
    .map((entry) => `${entry}: move repository-owned source, tests, types, or CI configuration under its owner`);
}

function rootEntriesFromDisk() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  return readdirSync(resolve(scriptDir, '..'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = findRootLayoutViolations(rootEntriesFromDisk());
  if (violations.length > 0) {
    console.error([
      `repository layout: ${violations.length} forbidden root entr${violations.length === 1 ? 'y' : 'ies'}`,
      ...violations.map((violation) => `- ${violation}`),
    ].join('\n'));
    process.exitCode = 1;
  } else {
    console.log('repository layout: no source, test, types, or dependency-cruiser entries at repository root');
  }
}
