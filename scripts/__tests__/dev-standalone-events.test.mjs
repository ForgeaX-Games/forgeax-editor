import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {test} from 'node:test';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const ROOT = resolve('.');
const SOURCE_PATH = resolve('scripts/dev-standalone.ts');
const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
const unixOnly = process.platform === 'win32' ? 'the lifecycle fixture requires POSIX process groups' : undefined;

function createFakeBun(tempDir) {
  const fakeBunPath = join(tempDir, 'fake-bun');
  writeFileSync(fakeBunPath, '#!/bin/sh\ncase "$*" in\n  *editor-edit-runtime*) exit 0;;\n  *) trap \'exit 0\' TERM INT; sleep 30;;\nesac\n', 'utf8');
  chmodSync(fakeBunPath, 0o755);
  return fakeBunPath;
}

function readEvents(eventLogPath) {
  return readFileSync(eventLogPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function waitForExit(child, timeoutMs = 3000) {
  return new Promise((resolvePromise, reject) => {
    if (child.exitCode !== null) {
      resolvePromise({code: child.exitCode, signal: child.signalCode});
      return;
    }
    const timer = setTimeout(() => reject(new Error('child did not exit before the fixture deadline')), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({code, signal});
    });
  });
}

async function waitForEvent(eventLogPath, child, predicate, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (child.exitCode !== null) throw new Error(`dev-standalone exited before the expected event: ${child.exitCode}`);
    try {
      const events = readEvents(eventLogPath);
      if (predicate(events)) return events;
    } catch {
      // The sink is created by the first lifecycle event.
    }
    await sleep(25);
  }
  throw new Error('dev-standalone did not emit the expected lifecycle event');
}

function fixtureEnvironment(fakeBunPath, eventLogPath) {
  const basePort = 24000 + (process.pid % 1000) * 6;
  return {
    ...process.env,
    CI_BUN_PATH: fakeBunPath,
    FORGEAX_BRIDGE: '0',
    FORGEAX_DEV_STACK_EVENT_LOG: eventLogPath,
    FORGEAX_STANDALONE_PORT: String(basePort),
    FORGEAX_EDIT_RUNTIME_PORT: String(basePort + 1),
    FORGEAX_GAME_API_PORT: String(basePort + 2),
    FORGEAX_PLAY_RUNTIME_PORT: String(basePort + 3),
    FORGEAX_RHI_REVIEWER_PORT: String(basePort + 4),
    FORGEAX_BRIDGE_PORT: String(basePort + 5),
  };
}

function spawnStandalone(env) {
  return spawn(process.execPath, [SOURCE_PATH], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('dev-standalone emits executable ordered lifecycle JSONL', {skip: unixOnly}, async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'forgeax-dev-standalone-test-'));
  const eventLogPath = join(tempDir, 'lifecycle.jsonl');
  const child = spawnStandalone(fixtureEnvironment(createFakeBun(tempDir), eventLogPath));
  try {
    await waitForEvent(eventLogPath, child, events => events.some(event => event.event === 'restart-scheduled'));
    child.kill('SIGTERM');
    const exit = await waitForExit(child);
    assert.notEqual(exit.code, 0);

    const events = readEvents(eventLogPath);
    const expectedFields = {
      started: ['event', 'service', 'pid'],
      exited: ['event', 'service', 'pid', 'code', 'signal', 'shuttingDown'],
      'restart-scheduled': ['event', 'service', 'attempt', 'maxAttempts', 'delayMs', 'code', 'signal'],
      shutdown: ['event', 'service', 'pid', 'code', 'signal', 'shuttingDown', 'reason'],
    };
    for (const event of events) {
      const fields = expectedFields[event.event];
      if (!fields) continue;
      for (const field of fields) assert.ok(Object.hasOwn(event, field), `${event.event} must expose ${field}`);
    }

    const firstIndex = event => events.findIndex(candidate => candidate.event === event);
    const startedIndex = firstIndex('started');
    const exitedIndex = firstIndex('exited');
    const restartIndex = firstIndex('restart-scheduled');
    const shutdownIndex = firstIndex('shutdown');
    assert.ok(startedIndex >= 0);
    assert.ok(exitedIndex > startedIndex);
    assert.ok(restartIndex > exitedIndex);
    assert.ok(shutdownIndex > restartIndex);
    assert.equal(events[shutdownIndex].shuttingDown, true);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    rmSync(tempDir, {recursive: true, force: true});
  }
});

test('dev-standalone exits nonzero when the lifecycle sink parent is missing', {skip: unixOnly}, async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'forgeax-dev-standalone-failure-test-'));
  const missingEventLogPath = join(tempDir, 'missing', 'lifecycle.jsonl');
  const child = spawnStandalone(fixtureEnvironment(createFakeBun(tempDir), missingEventLogPath));
  try {
    const exit = await waitForExit(child);
    assert.notEqual(exit.code, 0);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    rmSync(tempDir, {recursive: true, force: true});
  }
});
