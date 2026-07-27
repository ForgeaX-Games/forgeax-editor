#!/usr/bin/env node

// Editor submodule invariant: packages/engine must pin a commit reachable from
// forgeax-engine/main. A gitlink records only a SHA, so the .gitmodules branch
// field alone cannot prevent a PR from pinning an unmerged engine branch.

import { spawnSync } from 'node:child_process';
import process from 'node:process';

const ROOT = process.env.GITHUB_WORKSPACE ?? process.cwd();
const ENGINE_DIR = `${ROOT}/packages/engine`;

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
  console.error(`[engine-pin] ${message}`);
  process.exitCode = 1;
}

try {
  const configuredBranch = run('git', ['config', '-f', '.gitmodules', '--get', 'submodule.packages/engine.branch']);
  if (configuredBranch !== 'main') {
    throw new Error(`.gitmodules configures packages/engine.branch=${configuredBranch}; expected main`);
  }

  const gitlink = run('git', ['ls-tree', 'HEAD', 'packages/engine']);
  const match = gitlink.match(/^160000 commit ([0-9a-f]{40})\s+packages\/engine$/);
  if (!match) {
    throw new Error(`packages/engine is not a gitlink at HEAD: ${gitlink || '(missing)'}`);
  }
  const pin = match[1];

  // The checkout has the pinned object, while the shallow submodule clone may
  // not have main's history. Fetch only main, retaining the checked-out pin,
  // then test graph reachability instead of comparing against today's tip.
  const shallow = run('git', ['rev-parse', '--is-shallow-repository'], ENGINE_DIR);
  if (shallow === 'true') {
    run('git', ['fetch', '--no-tags', '--unshallow', 'origin', 'main'], ENGINE_DIR);
  } else {
    run('git', ['fetch', '--no-tags', 'origin', 'main'], ENGINE_DIR);
  }

  const main = run('git', ['rev-parse', 'FETCH_HEAD'], ENGINE_DIR);
  run('git', ['merge-base', '--is-ancestor', pin, main], ENGINE_DIR);
  console.log(`[engine-pin] ${pin} is reachable from forgeax-engine/main (${main})`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
