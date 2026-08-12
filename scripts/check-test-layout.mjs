#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const TEST_FILE_PATTERN = /(^|\/)[^/]+\.(?:test-d|test|spec|bench)\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const FORBIDDEN_DIRECTORY_PATTERN = /(^|\/)(?:test|tests|__test__)(?:\/|$)/;
const BENCHMARK_PATTERN = /(^|\/)bench\/[^/]+\.bench\.(?:ts|tsx|js|mjs|cjs)$/;

export function findTestLayoutViolations(trackedFiles) {
  const violations = [];
  const testFiles = trackedFiles.filter((file) => TEST_FILE_PATTERN.test(file));

  for (const file of testFiles) {
    if (FORBIDDEN_DIRECTORY_PATTERN.test(file)) {
      violations.push(
        `${file}: use __tests__/ instead of a singular or non-underscored test directory`,
      );
      continue;
    }

    if (!/(^|\/)__tests__\//.test(file) && !BENCHMARK_PATTERN.test(file)) {
      violations.push(`${file}: test-like files must live under __tests__/ or bench/`);
    }
  }

  return { testFiles, violations };
}

export function formatTestLayoutReport(trackedFiles) {
  const { testFiles, violations } = findTestLayoutViolations(trackedFiles);
  if (violations.length > 0) {
    return [
      `test layout: ${violations.length} violation(s)`,
      ...violations.map((violation) => `- ${violation}`),
    ].join('\n');
  }

  const benchmarkCount = testFiles.filter((file) => BENCHMARK_PATTERN.test(file)).length;
  return `test layout: ${testFiles.length} test-like files valid (${testFiles.length - benchmarkCount} under __tests__, ${benchmarkCount} under bench)`;
}

function trackedFilesFromGit() {
  return execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean)
    // During a local rename, the old path can remain in the index until the
    // user stages the move. The contract describes the working tree, so do not
    // report a test file that no longer exists on disk.
    .filter((file) => existsSync(resolve(file)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const trackedFiles = trackedFilesFromGit();
  const { violations } = findTestLayoutViolations(trackedFiles);
  if (violations.length > 0) {
    console.error(formatTestLayoutReport(trackedFiles));
    process.exitCode = 1;
  } else {
    console.log(formatTestLayoutReport(trackedFiles));
  }
}
