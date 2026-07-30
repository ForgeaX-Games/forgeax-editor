import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const editorRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = {
  manifestVersion: '1.0.0',
  adapterId: 'standalone-editor-public-adapter',
  entrypoint: '@forgeax/editor/compatibility-adapter',
} as const;

type SmokeStep = 'boot' | 'open' | 'catalog' | 'save' | 'play' | 'stop';
type SmokeObservation = {
  step: SmokeStep;
  outcome: 'passed' | 'failed' | 'error' | 'skipped';
  evidence: string;
  reason?: string;
};

type CommandResult = {
  ok: boolean;
  evidence: string;
  reason?: string;
};

function gitRevision(cwd: string): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`cannot resolve immutable revision for ${cwd}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function gitCommitExists(cwd: string, revision: string): boolean {
  const result = spawnSync('git', ['cat-file', '-e', `${revision}^{commit}`], {
    cwd,
    encoding: 'utf8',
  });
  return result.status === 0;
}

function gitIsAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd,
    encoding: 'utf8',
  });
  return result.status === 0;
}

function run(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, {
    cwd: editorRoot,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  const tail = output.split('\n').slice(-12).join('\n');
  return result.status === 0
    ? { ok: true, evidence: `${command} ${args.join(' ')} (exit 0)\n${tail}` }
    : {
        ok: false,
        evidence: `${command} ${args.join(' ')} (exit ${result.status ?? 'signal'})\n${tail}`,
        reason: `real product smoke exited ${result.status ?? 'by signal'}`,
      };
}

export function createAdapter(options: { readonly contractRoot?: string } = {}) {
  const contractRoot = options.contractRoot ?? process.cwd();
  const productRevision = gitRevision(editorRoot);
  const contractRevision = gitRevision(contractRoot);
  const adapterRevision = productRevision;
  const immutable =
    gitCommitExists(editorRoot, productRevision) &&
    gitCommitExists(contractRoot, contractRevision) &&
    gitCommitExists(editorRoot, adapterRevision);
  const isAncestor =
    immutable && gitIsAncestor(editorRoot, adapterRevision, productRevision);
  let storageResult: CommandResult | undefined;
  let gameplayResult: CommandResult | undefined;

  return {
    pin: {
      product: 'standalone-editor' as const,
      productRevision,
      contractRevision,
      adapterRevision,
      publicManifest: manifest,
      revisionEvidence: { immutable, isAncestor },
    },
    manifest,
    smoke(step: SmokeStep): SmokeObservation {
      const storageSteps: readonly SmokeStep[] = ['boot', 'open', 'catalog', 'save'];
      const result = storageSteps.includes(step)
        ? storageResult ??= run('bun', ['run', 'selfcheck:b2'])
        : gameplayResult ??= run('bun', ['run', 'test:e2e', 'e2e/public-compatibility.spec.ts']);
      return {
        step,
        outcome: result.ok ? 'passed' : 'failed',
        evidence: result.evidence,
        ...(result.reason ? { reason: result.reason } : {}),
      };
    },
  };
}
