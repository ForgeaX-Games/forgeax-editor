import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {chmodSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {test} from 'node:test';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const ROOT = resolve('.');
const SOURCE_PATH = resolve('scripts/dev-standalone.ts');
const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
const unixOnly = process.platform === 'win32' ? 'sequential teardown requires POSIX process groups' : undefined;

function listenPids(port) {
  const result = spawnSync('lsof', ['-ti', `:${port}`], {encoding: 'utf8'});
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout.split('\n').map(line => line.trim()).filter(Boolean);
}

function createFakeBun(tempDir) {
  const fakeBunPath = join(tempDir, 'fake-bun');
  writeFileSync(fakeBunPath, `#!/bin/sh
case "$*" in
  *editor-edit-runtime*)
    PORT="\${FORGEAX_EDIT_RUNTIME_PORT:-0}"
    exec node -e "require('http').createServer((_,r)=>{r.writeHead(200);r.end('ok')}).listen(Number(process.env.FORGEAX_EDIT_RUNTIME_PORT||0))"
    ;;
  *game-backend*)
    exec node -e "require('http').createServer((_,r)=>{r.writeHead(200);r.end('ok')}).listen(Number(process.env.FORGEAX_GAME_API_PORT||0))"
    ;;
  *run\\ dev*|*vite.config.ts*)
    exec node -e "require('http').createServer((_,r)=>{r.writeHead(200);r.end('ok')}).listen(Number(process.env.FORGEAX_STANDALONE_PORT||process.env.FORGEAX_INTERFACE_PORT||0))"
    ;;
  *) trap 'exit 0' TERM INT; sleep 30;;
esac
`, 'utf8');
  chmodSync(fakeBunPath, 0o755);
  return fakeBunPath;
}

function fixtureEnvironment(fakeBunPath, editPort) {
  const basePort = editPort - 1;
  return {
    ...process.env,
    CI_BUN_PATH: fakeBunPath,
    FORGEAX_BRIDGE: '0',
    FORGEAX_STANDALONE_PORT: String(basePort),
    FORGEAX_EDIT_RUNTIME_PORT: String(editPort),
    FORGEAX_GAME_API_PORT: String(basePort + 2),
    FORGEAX_PLAY_RUNTIME_PORT: String(basePort + 3),
    FORGEAX_RHI_REVIEWER_PORT: String(basePort + 4),
    FORGEAX_BRIDGE_PORT: String(basePort + 5),
  };
}

async function waitForPort(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (listenPids(port).length > 0) return;
    await sleep(25);
  }
  throw new Error(`port ${port} did not become ready`);
}

async function waitForPortFree(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (listenPids(port).length === 0) return;
    await sleep(25);
  }
  throw new Error(`port ${port} remained busy after teardown`);
}

async function runStandaloneCycle(fakeBunPath, editPort) {
  const child = spawn(process.execPath, [SOURCE_PATH], {
    cwd: ROOT,
    env: fixtureEnvironment(fakeBunPath, editPort),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForPort(editPort);
    child.kill('SIGTERM');
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error('dev-standalone did not exit after SIGTERM')), 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolvePromise(undefined);
      });
    });
    await waitForPortFree(editPort);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
}

test('dev-standalone SIGTERM frees edit-runtime port for a sequential smoke rerun', {skip: unixOnly}, async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'forgeax-smoke-teardown-test-'));
  const fakeBunPath = createFakeBun(tempDir);
  const editPort = 24000 + (process.pid % 1000) * 6 + 1;
  try {
    await runStandaloneCycle(fakeBunPath, editPort);
    await runStandaloneCycle(fakeBunPath, editPort);
  } finally {
    rmSync(tempDir, {recursive: true, force: true});
    assert.equal(listenPids(editPort).length, 0);
  }
});
