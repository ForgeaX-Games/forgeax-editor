#!/usr/bin/env node
// Admit PR-head GitHub Actions workflow definitions from the trusted base.
// This script reads workflow files only; it never imports, installs, or runs PR-head code.

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const ACTIONLINT_VERSION = '1.7.12';
export const ACTIONLINT_ARGS = Object.freeze([
  '-config-file',
  '.github/actionlint.yaml',
  '-shellcheck=',
  '-ignore',
  'constant expression "false" in condition',
]);

const WORKFLOW_SUFFIXES = Object.freeze(['.yml', '.yaml']);

/**
 * Return every directly-addressable GitHub Actions workflow file in deterministic order.
 * GitHub workflow files live directly under .github/workflows; non-YAML files are ignored.
 */
export function enumerateWorkflowFiles(workflowsDir) {
  const directory = resolve(workflowsDir);
  const files = readdirSync(directory)
    .filter((name) => WORKFLOW_SUFFIXES.some((suffix) => name.endsWith(suffix)))
    .map((name) => join(directory, name))
    .filter((path) => statSync(path).isFile())
    .sort((left, right) => left.localeCompare(right));

  if (files.length === 0) {
    throw new Error(`no .yml or .yaml workflow files found in ${directory}`);
  }
  return files;
}

/**
 * Invoke the pinned Actions-aware parser against the derived workflow file set.
 * The caller controls cwd so actionlint configuration comes from the trusted base.
 */
export function runActionlint({
  workflowsDir,
  actionlintBin = 'actionlint',
  cwd = process.cwd(),
} = {}) {
  if (typeof workflowsDir !== 'string' || workflowsDir.trim().length === 0) {
    throw new Error('workflowsDir is required');
  }
  const files = enumerateWorkflowFiles(workflowsDir);
  const args = [...ACTIONLINT_ARGS, ...files];
  const result = spawnSync(actionlintBin, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    throw new Error(`could not invoke ${actionlintBin}: ${result.error.message}`);
  }

  return {
    actionlintBin,
    args,
    files,
    status: result.status ?? 1,
    signal: result.signal ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function argumentValue(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) {
    process.stdout.write(
      'Usage: node scripts/ci/check-workflow-admission.mjs --workflows-dir <dir> [--actionlint-bin <path>]\n',
    );
    return;
  }

  const workflowsDir = argumentValue(argv, '--workflows-dir', '.github/workflows');
  const actionlintBin = argumentValue(argv, '--actionlint-bin', 'actionlint');
  try {
    const result = runActionlint({ workflowsDir, actionlintBin });
    if (result.status !== 0) {
      process.stderr.write(
        `[reason] workflow-admission-parser: actionlint ${ACTIONLINT_VERSION} rejected ${result.files.length} workflow file(s)\n${result.stderr || result.stdout}`,
      );
      process.exitCode = result.status > 0 ? result.status : 1;
      return;
    }
    process.stdout.write(
      `[ok] workflow admission: actionlint ${ACTIONLINT_VERSION} validated ${result.files.length} file(s): ${result.files.map((file) => basename(file)).join(', ')}\n`,
    );
  } catch (error) {
    process.stderr.write(`[reason] workflow-admission-parser: ${error.message ?? error}\n`);
    process.exitCode = 1;
  }
}

const invoked =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invoked) main();
