#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
// sync-harness.mjs — materialise the .forgeax-harness floating clone.
//
// .forgeax-harness is a standalone clone of forgeax-editor-harness, nested at
// <editor>/.forgeax-harness/ but gitignored + untracked by the editor (NOT a
// submodule — see .forgeax-harness/docs/specs/2026-06-17-harness-floating-clone.md). This script
// clones it on first run and fast-forwards it on later runs, so fresh checkouts
// + CI get the harness without `git submodule`.
//
// Wired to `postinstall`; also runnable as `bun run harness:sync`.
//
// Failure policy:
//   - FORGEAX_SKIP_HARNESS_SYNC set        -> exit 0 (editor build/test do not
//     need the harness; CI opts in only where required).
//   - offline / clone or fetch unreachable -> warn, exit 0 (graceful: a missing
//     harness must not break `bun install`).
//   - LOUD failure (exit 1) ONLY when a local clone has diverged from origin and
//     `pull --ff-only` would lose un-pushed loop state.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const DIR = resolve(root, '.forgeax-harness');
const REPO = 'https://github.com/ForgeaX-Games/forgeax-editor-harness.git';

// Never let git block on a TTY prompt or a GUI credential helper. Every git
// invocation below inherits these — a fresh HTTPS clone without a working SSH
// key / PAT will fail fast (warnExit0) instead of hanging waiting on stdin.
const gitEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
};
const NO_CRED = ['-c', 'credential.helper='];

function git(args, opts = {}) {
  return spawnSync('git', [...NO_CRED, ...args], { encoding: 'utf8', env: gitEnv, ...opts });
}

// SSH fallback for the private forgeax-editor-harness repo. REPO is HTTPS but
// the repo is private; accounts with 2FA can't auth over HTTPS without a PAT.
// Prefer SSH when a working GitHub key is present; else fall back to a PAT via
// GH_TOKEN / GITHUB_TOKEN. If neither is available, we still return the HTTPS
// url — the clone will fail fast (prompt disabled) with a clear warning rather
// than hang waiting on stdin.
//
// Exported so specs can exercise the branch table without touching the network.
// Injectable deps (env / sshProbe / warn) keep the function pure.
export function resolveCloneUrl(
  repo = REPO,
  env = process.env,
  sshProbe = defaultSshProbe,
  warn = (msg) => process.stdout.write(msg),
) {
  if (!repo.startsWith('https://github.com/')) return { url: repo, strategy: 'https-noauth' };
  if (sshProbe()) return { url: repo.replace('https://github.com/', 'git@github.com:'), strategy: 'ssh' };
  const tok = env.GH_TOKEN ?? env.GITHUB_TOKEN;
  if (tok) {
    return {
      url: repo.replace('https://github.com/', `https://x-access-token:${tok}@github.com/`),
      strategy: 'pat',
    };
  }
  warn(
    '[harness:sync] no GitHub SSH key or GH_TOKEN detected; HTTPS clone of ' +
      'private forgeax-editor-harness will fail without prompting.\n',
  );
  return { url: repo, strategy: 'https-noauth' };
}

function defaultSshProbe() {
  const probe = spawnSync(
    'ssh',
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-T', 'git@github.com'],
    { encoding: 'utf8' },
  );
  return `${probe.stdout || ''}${probe.stderr || ''}`.includes('successfully authenticated');
}

function cloneUrl() {
  return resolveCloneUrl().url;
}

function warnExit0(msg) {
  process.stdout.write(`[harness:sync] ${msg} — continuing\n`);
  process.exit(0);
}

function failLoud(msg) {
  process.stderr.write(`[harness:sync] FORGEAX_HARNESS_DIVERGED: ${msg}\n`);
  process.exit(1);
}

// Only run the main sync flow when invoked directly (not when a spec imports).
if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}

function main() {
  if (process.env.FORGEAX_SKIP_HARNESS_SYNC) {
    process.stdout.write('[harness:sync] FORGEAX_SKIP_HARNESS_SYNC set — skipped\n');
    process.exit(0);
  }

  if (!existsSync(resolve(DIR, '.git'))) {
    // First run (or a fresh checkout): clone. Offline → graceful skip.
    const r = git(['clone', '--quiet', cloneUrl(), DIR], { cwd: root });
    if (r.status !== 0) {
      warnExit0(
        `clone failed (offline?); .forgeax-harness not materialised:\n${(r.stderr || '').trim()}`,
      );
    }
    process.stdout.write('[harness:sync] cloned forgeax-editor-harness\n');
    process.exit(0);
  }

  // Existing clone: fast-forward to origin/main. Never clobber local divergence.
  // Ensure the remote URL uses the best available auth strategy (SSH > PAT > HTTPS).
  // The initial clone may have used SSH, but `git remote` always records the URL
  // as passed; if the clone was done with HTTPS + PAT, later fetches without the
  // token will fail silently. Normalise before every fetch so the harness stays
  // up-to-date regardless of how it was originally cloned.
  const bestUrl = resolveCloneUrl().url;
  if (bestUrl) {
    const currentUrl = git(['remote', 'get-url', 'origin'], { cwd: DIR }).stdout.trim();
    if (currentUrl && currentUrl !== bestUrl) {
      git(['remote', 'set-url', 'origin', bestUrl], { cwd: DIR });
    }
  }

  const fetch = git(['fetch', '--quiet', 'origin', 'main'], { cwd: DIR });
  if (fetch.status !== 0) {
    warnExit0(
      `fetch failed (offline?); leaving .forgeax-harness as-is:\n${(fetch.stderr || '').trim()}`,
    );
  }

  const ff = git(['merge', '--ff-only', 'origin/main'], { cwd: DIR });
  if (ff.status === 0) {
    process.stdout.write('[harness:sync] fast-forwarded .forgeax-harness to origin/main\n');
    process.exit(0);
  }

  // ff-only refused. Distinguish "local has un-pushed commits" (loud, real risk)
  // from a transient/no-op state (graceful).
  const ahead = git(['rev-list', '--count', 'origin/main..HEAD'], { cwd: DIR });
  const aheadN = Number.parseInt((ahead.stdout || '0').trim(), 10) || 0;
  if (aheadN > 0) {
    failLoud(
      `local .forgeax-harness has ${aheadN} commit(s) not on origin/main; ` +
        'refusing to fast-forward (would not lose them, but the tree has ' +
        'diverged). Push or reconcile manually:\n' +
        '  git -C .forgeax-harness push   # or: git -C .forgeax-harness log origin/main..HEAD',
    );
  }
  warnExit0(
    `ff-only no-op (already up to date or detached); leaving as-is:\n${(ff.stderr || '').trim()}`,
  );
}
