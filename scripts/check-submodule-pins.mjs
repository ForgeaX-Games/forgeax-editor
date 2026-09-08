#!/usr/bin/env node

// Editor submodule invariant: every top-level submodule must pin a commit
// reachable from its configured main branch. A gitlink records only a SHA, so
// the .gitmodules branch field alone cannot prevent a PR from pinning an
// unmerged submodule branch.

import { spawnSync } from 'node:child_process';
import process from 'node:process';

const ROOT = process.env.GITHUB_WORKSPACE ?? process.cwd();

// Scriptable Scene publication requires the Engine template-scene producer
// baseline. Keep this immutable lower bound beside the gate so a gitlink that
// predates the approved producer cannot pass merely because it is reachable
// from a newer branch tip.
const ENGINE_MINIMUM_BASELINE = '57c2271bf2ab03474c876a8702d0776dcfa991a2';

function run(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout.trim();
}

function fail(message) {
  console.error(`[submodule-pin] ${message}`);
  process.exitCode = 1;
}

try {
  const configuredSubmodules = run('git', [
    'config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$',
  ])
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^submodule\.(.+)\.path (.+)$/);
      if (!match) throw new Error(`invalid .gitmodules path entry: ${line}`);
      return { name: match[1], path: match[2] };
    });

  if (configuredSubmodules.length === 0) {
    throw new Error('.gitmodules contains no submodules');
  }

  for (const { name, path } of configuredSubmodules) {
    const configuredBranch = run('git', [
      'config', '-f', '.gitmodules', '--get', `submodule.${name}.branch`,
    ]);
    if (configuredBranch !== 'main') {
      throw new Error(`.gitmodules configures ${path}.branch=${configuredBranch}; expected main`);
    }

    const gitlink = run('git', ['ls-tree', 'HEAD', path]);
    const match = gitlink.match(/^160000 commit ([0-9a-f]{40})\t(.+)$/);
    if (!match || match[2] !== path) {
      throw new Error(`${path} is not a gitlink at HEAD: ${gitlink || '(missing)'}`);
    }
    const pin = match[1];
    const directory = `${ROOT}/${path}`;

    // Do not recurse into nested submodules while fetching the branch history.
    // A nested gitlink may reference an object that was removed upstream even
    // when this top-level pin is valid; that must not make this check fail.
    const shallow = run('git', ['rev-parse', '--is-shallow-repository'], directory);
    const fetchArgs = ['fetch', '--no-tags', '--no-recurse-submodules'];
    fetchArgs.push(...(shallow === 'true' ? ['--unshallow', 'origin', 'main'] : ['origin', 'main']));
    run('git', fetchArgs, directory);

    const main = run('git', ['rev-parse', 'FETCH_HEAD'], directory);

    // The CI checkout is intentionally shallow. Fetching main must happen
    // before validating the immutable Engine baseline because the baseline may
    // not be present in the one-commit checkout even though it is an ancestor
    // of the fetched branch.
    if (path === 'packages/engine') {
      run('git', ['cat-file', '-e', `${ENGINE_MINIMUM_BASELINE}^{commit}`], directory);
      run('git', ['merge-base', '--is-ancestor', ENGINE_MINIMUM_BASELINE, pin], directory);
    }

    run('git', ['merge-base', '--is-ancestor', pin, main], directory);
    console.log(`[submodule-pin] ${path}: ${pin} is reachable from main (${main})`);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
