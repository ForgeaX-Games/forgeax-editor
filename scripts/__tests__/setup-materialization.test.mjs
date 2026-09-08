import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { BUN_EXECUTABLE } from '../ci/bun-runtime.mjs';

const sourceRoot = resolve(import.meta.dir, '../..');
const editorSyncSource = join(sourceRoot, 'scripts', 'sync-harness.mjs');
const engineSyncSource = join(sourceRoot, 'packages', 'engine', 'scripts', 'sync-harness.mjs');
const enginePackages = ['geometry', 'import', 'vite-plugin-shader', 'app', 'runtime', 'ecs', 'types', 'shader', 'gltf', 'npc'];

function run(command, args, cwd, extraEnv = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {...process.env, ...extraEnv},
    maxBuffer: 16 * 1024 * 1024,
  });
}

function git(args, cwd) {
  const result = run('git', ['-c', 'protocol.file.allow=always', ...args], cwd);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}:\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function writeExecutable(path, content) {
  writeFileSync(path, content, {mode: 0o755});
  chmodSync(path, 0o755);
}

function makeHarnessRemote() {
  const root = mkdtempSync(join(tmpdir(), 'fx-harness-remote-'));
  const work = join(root, 'work');
  const remote = join(root, 'remote.git');
  mkdirSync(work, {recursive: true});
  git(['init', '-b', 'main'], work);
  git(['config', 'user.email', 'fixture@example.invalid'], work);
  git(['config', 'user.name', 'setup fixture'], work);
  mkdirSync(join(work, 'docs'), {recursive: true});
  writeFileSync(join(work, 'docs', 'README.md'), '# fixture harness\n');
  mkdirSync(join(work, 'full-only'), {recursive: true});
  writeFileSync(join(work, 'full-only', 'marker.txt'), 'full checkout marker\n');
  git(['add', '.'], work);
  git(['commit', '-m', 'fixture: initial harness'], work);
  git(['clone', '--bare', work, remote], root);
  git(['remote', 'add', 'origin', remote], work);
  return {root, work, remote: `file://${remote}`};
}

function syncScript(source, destination, remote) {
  mkdirSync(dirname(destination), {recursive: true});
  const text = readFileSync(source, 'utf8').replace(
    /const REPO = '[^']+';/,
    `const REPO = ${JSON.stringify(remote)};`,
  );
  writeFileSync(destination, text);
}

function gitSparseMode(target) {
  const config = run('git', ['-C', target, 'config', '--get', 'core.sparseCheckout'], target);
  if (config.status !== 0 || config.stdout.trim() !== 'true') return 'full';
  const patterns = run('git', ['-C', target, 'sparse-checkout', 'list'], target);
  return patterns.status === 0 && patterns.stdout.trim() === 'docs' ? 'sparse' : 'unknown';
}

function gitEnv() {
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'protocol.file.allow',
    GIT_CONFIG_VALUE_0: 'always',
  };
}

function runSyncConsumer({kind, root, remote, requestedSparse, strictDivergence = false}) {
  const source = kind === 'editor' ? editorSyncSource : engineSyncSource;
  const relative = kind === 'editor'
    ? join('scripts', 'sync-harness.mjs')
    : join('packages', 'engine', 'scripts', 'sync-harness.mjs');
  const destination = join(root, relative);
  syncScript(source, destination, remote);
  return run(process.execPath, [destination], root, {
    ...gitEnv(),
    FORGEAX_HARNESS_SPARSE_DOCS: requestedSparse,
    ...(strictDivergence ? {FORGEAX_HARNESS_STRICT: '1'} : {}),
  });
}

function consumerRoot(root, kind) {
  return kind === 'engine' ? join(root, 'packages', 'engine') : root;
}

function prepareExistingClone(root, remote, mode, kind) {
  const targetRoot = consumerRoot(root, kind);
  mkdirSync(targetRoot, {recursive: true});
  const target = join(targetRoot, '.forgeax-harness');
  if (mode === 'full') {
    git(['clone', remote, target], root);
  } else {
    git(['clone', '--filter=blob:none', '--sparse', '--no-checkout', remote, target], root);
    git(['sparse-checkout', 'set', 'docs'], target);
    git(['read-tree', '-mu', 'HEAD'], target);
  }
  writeFileSync(join(target, 'local-protected.txt'), 'must survive sync\n');
  return target;
}

function advanceRemote(remoteWork, remote) {
  const countPath = join(remoteWork, '.advance-count');
  const count = existsSync(countPath) ? Number.parseInt(readFileSync(countPath, 'utf8'), 10) + 1 : 1;
  writeFileSync(countPath, String(count));
  writeFileSync(join(remoteWork, `remote-advance-${count}.txt`), 'remote update\n');
  git(['add', '.'], remoteWork);
  git(['commit', '-m', 'fixture: remote advance'], remoteWork);
  git(['push', 'origin', 'main'], remoteWork);
}

function createSetupFixture(stage) {
  const root = mkdtempSync(join(tmpdir(), `fx-setup-${stage}-`));
  cpSync(join(sourceRoot, 'scripts'), join(root, 'scripts'), {recursive: true});
  writeFileSync(join(root, 'package.json'), '{"private":true}\n');
  writeFileSync(join(root, '.gitignore'), 'node_modules/\npackages/engine/node_modules/\npackages/engine/packages/*/dist/\npackages/engine/packages/*/pkg/\npackages/engine/.dist-sha\n');
  mkdirSync(join(root, 'node_modules', '.bin'), {recursive: true});
  writeFileSync(join(root, 'node_modules', '.bin', 'tsc'), 'fixture tsc\n');
  cpSync(realpathSync(join(sourceRoot, 'node_modules', 'yaml')), join(root, 'node_modules', 'yaml'), {recursive: true});
  git(['init', '-b', 'main'], root);
  git(['config', 'user.email', 'fixture@example.invalid'], root);
  git(['config', 'user.name', 'setup fixture'], root);
  git(['add', 'package.json', '.gitignore', 'scripts'], root);
  git(['commit', '-m', 'fixture: editor setup root'], root);

  const engine = join(root, 'packages', 'engine');
  mkdirSync(engine, {recursive: true});
  writeFileSync(join(engine, 'package.json'), '{"name":"fixture-engine"}\n');
  writeFileSync(join(engine, '.gitignore'), 'node_modules/\npackages/*/dist/\npackages/*/pkg/\n.dist-sha\n');
  mkdirSync(join(engine, 'node_modules', 'typescript', 'bin'), {recursive: true});
  writeFileSync(join(engine, 'node_modules', 'typescript', 'bin', 'tsc'), 'fixture tsc\n');
  for (const pkg of enginePackages) {
    const dist = join(engine, 'packages', pkg, 'dist');
    mkdirSync(dist, {recursive: true});
    writeFileSync(join(dist, 'index.mjs'), 'export {};\n');
    writeFileSync(join(dist, 'index.d.ts'), 'export {};\n');
    writeFileSync(join(dist, 'index.d.ts.map'), '{}\n');
  }
  const wgpuPkg = join(engine, 'packages', 'wgpu-wasm', 'pkg');
  const wgpuScripts = join(engine, 'packages', 'wgpu-wasm', 'scripts');
  const ddcSource = join(engine, 'packages', 'ddc', 'src');
  const fbxPkg = join(engine, 'packages', 'fbx', 'pkg');
  const codecPkg = join(engine, 'packages', 'codec', 'pkg');
  mkdirSync(wgpuScripts, {recursive: true});
  writeFileSync(
    join(wgpuScripts, 'content-key.mjs'),
    "process.stdout.write(`${'a'.repeat(64)}\\nwgpu-wasm-pkg-fixture.tar.gz\\n`);\n",
  );
  mkdirSync(ddcSource, {recursive: true});
  writeFileSync(join(ddcSource, 'status.ts'), "export const DDC_STATUS_SCHEMA = 'forgeax-ddc-status/v2' as const;\n");
  mkdirSync(join(codecPkg, 'encode'), {recursive: true});
  if (stage !== 'wgpu') {
    mkdirSync(wgpuPkg, {recursive: true});
    writeFileSync(join(wgpuPkg, 'wgpu_wasm_bg.wasm'), 'fixture\n');
  }
  if (stage !== 'fbx') {
    mkdirSync(fbxPkg, {recursive: true});
    writeFileSync(join(fbxPkg, 'fbx-wasm.mjs'), 'export {};\n');
    writeFileSync(join(fbxPkg, 'fbx-wasm.wasm'), 'fixture\n');
  }
  if (stage !== 'codec') {
    writeFileSync(join(codecPkg, 'basis_transcoder.mjs'), 'export {};\n');
    writeFileSync(join(codecPkg, 'basis_transcoder.wasm'), 'fixture\n');
    writeFileSync(join(codecPkg, 'encode', 'basis_encoder.wasm'), 'fixture\n');
  }
  if (stage === 'critical') rmSync(join(engine, 'packages', 'geometry', 'dist', 'index.mjs'));
  git(['init', '-b', 'main'], engine);
  git(['config', 'user.email', 'fixture@example.invalid'], engine);
  git(['config', 'user.name', 'setup fixture'], engine);
  git(['add', 'package.json', '.gitignore', 'packages/wgpu-wasm/scripts/content-key.mjs', 'packages/ddc/src/status.ts'], engine);
  git(['commit', '-m', 'fixture: engine pin'], engine);
  writeFileSync(join(engine, '.dist-sha'), `${git(['rev-parse', 'HEAD'], engine).stdout.trim()}\n`);

  const bin = join(root, 'fixture-bin');
  const log = join(root, 'pnpm.log');
  mkdirSync(bin, {recursive: true});
  const fail = {
    'engine-pnpm': 'case "$*" in install*) exit 41;; esac',
    wgpu: 'case "$*" in *engine-wgpu-wasm*) exit 42;; esac',
    fbx: 'case "$*" in *engine-fbx*) exit 43;; esac',
    codec: 'case "$*" in *engine-codec*) exit 44;; esac',
    'engine-dist': 'if [ "$1" = "-r" ]; then exit 45; fi',
    declaration: 'case "$*" in *tsc*--clean*) ;; *tsc*) exit 46;; esac',
    critical: '',
  }[stage] ?? '';
  writeExecutable(join(bin, 'pnpm'), `#!/bin/sh
if [ -n "$FX_SETUP_FIXTURE_LOG" ]; then printf '%s\\n' "$*" >> "$FX_SETUP_FIXTURE_LOG"; fi
${fail}
exit 0
`);
  writeExecutable(join(bin, 'rustc'), '#!/bin/sh\nexit 0\n');
  writeExecutable(join(bin, 'wasm-pack'), '#!/bin/sh\nexit 0\n');
  writeExecutable(join(bin, 'emcc'), '#!/bin/sh\nexit 0\n');
  return {root, bin, log};
}

function runSetupFixture(fixture) {
  const path = [fixture.bin, dirname(BUN_EXECUTABLE), process.env.PATH].filter(Boolean).join(delimiter);
  return run(BUN_EXECUTABLE, [join(fixture.root, 'scripts', 'fx.ts'), 'setup'], fixture.root, {
    PATH: path,
    FORGEAX_HARNESS_SPARSE_DOCS: '1',
    FORGEAX_SKIP_HARNESS_SYNC: '1',
    FORGEAX_SKIP_EDITOR_BUN_INSTALL: '1',
    FX_SETUP_FIXTURE_LOG: fixture.log,
  });
}

function terminalEnvelope(result) {
  const lines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).filter((line) => line.startsWith('{'));
  if (lines.length === 0) {
    throw new Error(`setup fixture emitted no terminal envelope (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return JSON.parse(lines.at(-1));
}

test('Editor and Engine sync consumers execute deterministic full/sparse fixtures', () => {
  const remote = makeHarnessRemote();
  try {
    for (const kind of ['editor', 'engine']) {
      for (const requestedSparse of ['0', '1']) {
        const fixture = mkdtempSync(join(tmpdir(), `fx-sync-fresh-${kind}-`));
        try {
          const result = runSyncConsumer({kind, root: fixture, remote: remote.remote, requestedSparse});
          expect(result.status).toBe(0);
          const target = join(consumerRoot(fixture, kind), '.forgeax-harness');
          expect(gitSparseMode(target)).toBe(requestedSparse === '1' ? 'sparse' : 'full');
          if (!existsSync(join(target, 'docs', 'README.md'))) {
            throw new Error(`sync did not materialize docs for ${kind}/${requestedSparse}:\n${result.stdout}\n${result.stderr}`);
          }
          expect(existsSync(join(target, 'full-only', 'marker.txt'))).toBe(requestedSparse === '0');
        } finally {
          rmSync(fixture, {recursive: true, force: true});
        }
      }
    }
  } finally {
    rmSync(remote.root, {recursive: true, force: true});
  }
});

test('Editor and Engine sync consumers preserve existing shape and refuse divergence', () => {
  const remote = makeHarnessRemote();
  try {
    for (const kind of ['editor', 'engine']) {
      for (const existingMode of ['full', 'sparse']) {
        const fixture = mkdtempSync(join(tmpdir(), `fx-sync-existing-${kind}-`));
        try {
          const target = prepareExistingClone(fixture, remote.remote, existingMode, kind);
          const requestedSparse = existingMode === 'full' ? '1' : '0';
          const result = runSyncConsumer({kind, root: fixture, remote: remote.remote, requestedSparse});
          expect(result.status).toBe(0);
          expect(gitSparseMode(target)).toBe(existingMode);
          expect(existsSync(join(target, 'local-protected.txt'))).toBe(true);
        } finally {
          rmSync(fixture, {recursive: true, force: true});
        }
      }
    }

    for (const kind of ['editor', 'engine']) {
      const fixture = mkdtempSync(join(tmpdir(), `fx-sync-diverged-${kind}-`));
      try {
        const target = prepareExistingClone(fixture, remote.remote, 'full', kind);
        writeFileSync(join(target, 'local-commit.txt'), 'local divergence\n');
        git(['add', 'local-commit.txt'], target);
        git(['commit', '-m', 'fixture: local divergence'], target);
        advanceRemote(remote.work, remote.remote);
        const result = runSyncConsumer({
          kind,
          root: fixture,
          remote: remote.remote,
          requestedSparse: '1',
          strictDivergence: true,
        });
        expect(result.status).toBe(1);
        expect(`${result.stdout}\n${result.stderr}`).toContain('FORGEAX_HARNESS_DIVERGED');
        expect(existsSync(join(target, 'local-commit.txt'))).toBe(true);
      } finally {
        rmSync(fixture, {recursive: true, force: true});
      }
    }
  } finally {
    rmSync(remote.root, {recursive: true, force: true});
  }
});

test('fx setup rebuilds an existing wgpu wasm when provenance is missing or stale', {timeout: 60000}, () => {
  const markerName = '.forgeax-wgpu-wasm-content-key';
  for (const markerState of ['missing', 'stale']) {
    const fixture = createSetupFixture('success');
    try {
      const marker = join(fixture.root, 'packages', 'engine', 'packages', 'wgpu-wasm', 'pkg', markerName);
      if (markerState === 'stale') writeFileSync(marker, `${'b'.repeat(64)}\n`);

      const result = runSetupFixture(fixture);
      const envelope = terminalEnvelope(result);
      expect(result.status).toBe(0);
      expect(envelope.code).toBe('setup-complete');
      expect(readFileSync(marker, 'utf8').trim()).toBe('a'.repeat(64));
      const invocations = readFileSync(fixture.log, 'utf8').split(/\r?\n/).filter(Boolean);
      expect(invocations.some((line) => line.includes('-F @forgeax/engine-wgpu-wasm build:wasm'))).toBe(true);
    } finally {
      rmSync(fixture.root, {recursive: true, force: true});
    }
  }
});

test('fx setup reuses wgpu wasm only when the source provenance marker matches', {timeout: 60000}, () => {
  const fixture = createSetupFixture('success');
  try {
    const marker = join(fixture.root, 'packages', 'engine', 'packages', 'wgpu-wasm', 'pkg', '.forgeax-wgpu-wasm-content-key');
    writeFileSync(marker, `${'a'.repeat(64)}\n`);

    const result = runSetupFixture(fixture);
    const envelope = terminalEnvelope(result);
    expect(result.status).toBe(0);
    expect(envelope.code).toBe('setup-complete');
    const invocations = readFileSync(fixture.log, 'utf8').split(/\r?\n/).filter(Boolean);
    expect(invocations.some((line) => line.includes('-F @forgeax/engine-wgpu-wasm build:wasm'))).toBe(false);
  } finally {
    rmSync(fixture.root, {recursive: true, force: true});
  }
});

test('fx setup emits the owning failure envelope for every downstream gate fixture', {timeout: 60000}, () => {
  const expected = {
    'engine-pnpm': ['engine-pnpm-install', 'pnpm-install-failed'],
    wgpu: ['wgpu-wasm-build', 'wgpu-wasm-build-failed'],
    fbx: ['fbx-wasm-build', 'fbx-wasm-build-failed'],
    codec: ['codec-wasm-build', 'codec-wasm-build-failed'],
    'engine-dist': ['engine-dist', 'engine-dist-build-failed'],
    declaration: ['declaration', 'declaration-build-failed'],
    critical: ['critical-artifact-verify', 'critical-artifact-missing'],
  };
  for (const stage of Object.keys(expected)) {
    const fixture = createSetupFixture(stage);
    try {
      const result = runSetupFixture(fixture);
      const envelope = terminalEnvelope(result);
      expect(result.status).toBe(1);
      expect(envelope.terminalStatus).toBe('failure');
      expect([envelope.phase, envelope.code]).toEqual(expected[stage]);
      expect(envelope.artifactsVerified).toBe(false);
    } finally {
      rmSync(fixture.root, {recursive: true, force: true});
    }
  }
});
