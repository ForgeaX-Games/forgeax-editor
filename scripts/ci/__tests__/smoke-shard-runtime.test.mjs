import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import { test } from 'node:test';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

let runtime;
let importError;
try {
  runtime = await import('../smoke-shard-runtime.mjs');
} catch (error) {
  importError = error;
}

function loadClassifier() {
  assert.equal(
    importError,
    undefined,
    `smoke-shard-runtime.mjs must be available: ${importError?.message ?? 'unknown import error'}`,
  );
  assert.equal(typeof runtime?.classifyFailure, 'function');
  return runtime.classifyFailure;
}

function loadRuntime() {
  loadClassifier();
  return runtime;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const flockAvailable = spawnSync('sh', ['-lc', 'command -v flock'], {stdio: 'ignore'}).status === 0;

function baseFailure(overrides = {}) {
  return {
    admissionValid: true,
    lockTimedOut: false,
    busyPorts: [],
    oomKillDelta: 0,
    lifecycleEvents: [],
    commandExitCode: 1,
    processGroupResidue: [],
    portResidue: [],
    ...overrides,
  };
}

function assertStructuredFailure(result, code) {
  assert.equal(result.status, 'failure');
  assert.equal(result.code, code);
  assert.equal(typeof result.expected, 'string');
  assert.equal(typeof result.observed, 'string');
  assert.equal(typeof result.hint, 'string');
  assert.ok(Array.isArray(result.evidenceRefs));
}

test('failure classification preserves the declared precedence and structured fields', () => {
  const classifyFailure = loadClassifier();
  const cases = [
    [baseFailure({ admissionValid: false }), 'smoke-shard-admission-invalid'],
    [baseFailure({ lockTimedOut: true }), 'smoke-shard-isolation-lock-timeout'],
    [baseFailure({ busyPorts: [{ port: 15890, pid: 71, command: 'vite', cwd: '/tmp/holder' }] }), 'smoke-shard-port-busy'],
    [baseFailure({ oomKillDelta: 1 }), 'smoke-shard-cgroup-oom'],
    [baseFailure({
      lifecycleEvents: [{ event: 'exited', service: 'standalone-host', signal: 'SIGKILL', shuttingDown: false }],
    }), 'smoke-shard-service-sigkill'],
    [baseFailure({ processGroupResidue: [901], portResidue: [15890] }), 'smoke-shard-teardown-residue'],
    [baseFailure({ commandExitCode: 1 }), 'smoke-shard-product-or-unclassified-failure'],
  ].map(([input, code]) => [classifyFailure(input), code]);

  for (const [result, code] of cases) assertStructuredFailure(result, code);

  const precedence = classifyFailure(baseFailure({
    admissionValid: false,
    lockTimedOut: true,
    busyPorts: [{ port: 15890, pid: 71 }],
    oomKillDelta: 1,
    lifecycleEvents: [{ event: 'exited', signal: 'SIGKILL', shuttingDown: false }],
    processGroupResidue: [901],
  }));
  assertStructuredFailure(precedence, 'smoke-shard-admission-invalid');
});

test('real lock commands wait for a competing owner and never return immediate timeout', {
  skip: flockAvailable ? undefined : 'flock is not available on this host',
}, async () => {
  const smokeRuntime = loadRuntime();
  const tempDir = mkdtempSync(join(tmpdir(), 'forgeax-smoke-lock-test-'));
  const lockPath = join(tempDir, 'lock');
  const logPath = join(tempDir, 'events.log');
  const commandScript = "const fs=require('node:fs');const file=process.env.FORGEAX_LOCK_FIXTURE_LOG;const label=process.env.FORGEAX_LOCK_FIXTURE_LABEL;fs.appendFileSync(file,label+':start\\n');setTimeout(()=>fs.appendFileSync(file,label+':end\\n'),150);";
  const spec = {file: process.execPath, args: ['-e', commandScript]};
  const lockOptions = {lockPath, lockTimeoutMs: 1500, teardownGraceMs: 25};
  let firstPromise;
  try {
    firstPromise = smokeRuntime.runLockedCommand(spec, {
      ...lockOptions,
      env: {FORGEAX_LOCK_FIXTURE_LOG: logPath, FORGEAX_LOCK_FIXTURE_LABEL: 'first'},
    });
    const deadline = Date.now() + 1000;
    let firstStarted = false;
    while (Date.now() <= deadline) {
      try {
        firstStarted = readFileSync(logPath, 'utf8').includes('first:start\n');
      } catch {
        // The first command has not acquired the lock yet.
      }
      if (firstStarted) break;
      await sleep(10);
    }
    if (!firstStarted) {
      const firstResult = await firstPromise;
      assert.fail(`first lock command did not start: ${JSON.stringify(firstResult)}`);
    }

    const secondPromise = smokeRuntime.runLockedCommand(spec, {
      ...lockOptions,
      env: {FORGEAX_LOCK_FIXTURE_LOG: logPath, FORGEAX_LOCK_FIXTURE_LABEL: 'second'},
    });
    const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);
    assert.equal(firstResult.code, 0);
    assert.equal(secondResult.code, 0);
    assert.notEqual(firstResult.code, 75);
    assert.notEqual(secondResult.code, 75);
    assert.deepEqual(readFileSync(logPath, 'utf8').trim().split('\n'), [
      'first:start',
      'first:end',
      'second:start',
      'second:end',
    ]);
  } finally {
    rmSync(tempDir, {recursive: true, force: true});
  }
});

test('admission accepts fuser when lsof is unavailable and probes through the selected fallback', async () => {
  const smokeRuntime = loadRuntime();
  const tempDir = mkdtempSync(join(tmpdir(), 'forgeax-smoke-runtime-test-'));
  const probeCalls = [];
  try {
    const result = await smokeRuntime.runShard({
      identity: {runId: 'run-1', attempt: '1', job: 'smoke-play', pool: 'runner', shard: 'fallback'},
      ports: [15890],
      command: [process.execPath, '-e', 'process.exit(0)'],
      lockPath: join(tempDir, 'lock'),
      reportPath: join(tempDir, 'runtime.json'),
      lockTimeoutMs: 5000,
      quietMs: 0,
      pollMs: 0,
      lookupTool: tool => tool === 'flock' || tool === 'fuser',
      runLockedCommand: async () => ({
        startedAt: '2026-01-01T00:00:00.000Z',
        acquiredAt: '2026-01-01T00:00:00.000Z',
        releasedAt: '2026-01-01T00:00:00.000Z',
        groupId: null,
        killedPids: [],
        code: 0,
        signal: null,
      }),
      run: (tool, args) => {
        probeCalls.push({tool, args});
        return '';
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.report.admission.tools.portTool, 'fuser');
    assert.deepEqual(result.report.admission.tools.missing, []);
    assert.equal(result.report.classification.code, smokeRuntime.FAILURE_CODES.passed);
    assert.equal(probeCalls.length, 2);
    assert.deepEqual(probeCalls.map(({tool}) => tool), ['fuser', 'fuser']);
  } finally {
    rmSync(tempDir, {recursive: true, force: true});
  }
});

test('fallback port inspectors parse fuser and ss holders with controlled Linux cwd lookup', () => {
  const smokeRuntime = loadRuntime();
  const fuserCalls = [];
  const fuserHolders = smokeRuntime.inspectPorts([15890], {
    portTool: 'fuser',
    platform: 'linux',
    run: (tool, args) => {
      fuserCalls.push({tool, args});
      return '15890/tcp:  71 72\n';
    },
    readLink: path => `/srv/fuser-${path.match(/proc\/(\d+)\/cwd/)[1]}`,
  });
  assert.deepEqual(fuserHolders.map(({port, pid, command, cwd, name}) => ({port, pid, command, cwd, name})), [
    {port: 15890, pid: 71, command: 'unknown', cwd: '/srv/fuser-71', name: '15890/tcp'},
    {port: 15890, pid: 72, command: 'unknown', cwd: '/srv/fuser-72', name: '15890/tcp'},
  ]);
  assert.deepEqual(fuserCalls.map(({tool}) => tool), ['fuser']);

  const ssHolders = smokeRuntime.inspectPorts([15890], {
    portTool: 'ss',
    platform: 'linux',
    run: () => 'LISTEN 0 128 127.0.0.1:15890 0.0.0.0:* users:(("node",pid=91,fd=17))\n',
    readLink: path => `/srv/ss-${path.match(/proc\/(\d+)\/cwd/)[1]}`,
  });
  assert.deepEqual(ssHolders.map(({port, pid, command, cwd}) => ({port, pid, command, cwd})), [
    {port: 15890, pid: 91, command: 'node', cwd: '/srv/ss-91'},
  ]);
});

test('fallback port inspectors report no holder for empty fuser and ss results', () => {
  const smokeRuntime = loadRuntime();
  const noFuserHolder = smokeRuntime.inspectPorts([15890], {
    portTool: 'fuser',
    run: () => {
      const error = new Error('no listener');
      error.status = 1;
      error.stdout = '';
      error.stderr = '';
      throw error;
    },
  });
  assert.deepEqual(noFuserHolder, []);

  const noSsHolder = smokeRuntime.inspectPorts([15890], {portTool: 'ss', run: () => ''});
  assert.deepEqual(noSsHolder, []);
});

test('non-empty unparseable port probes remain occupied instead of becoming free', () => {
  const smokeRuntime = loadRuntime();
  for (const tool of ['fuser', 'ss', 'lsof']) {
    const holders = smokeRuntime.inspectPorts([15890], {
      portTool: tool,
      run: () => 'malformed probe output\n',
    });
    assert.equal(holders.length, 1, `${tool} malformed output must remain non-empty`);
    assert.equal(holders[0].name, `${tool}:inspection-error`);
  }
});

test('runShard does not start the command when a fallback probe is malformed', async () => {
  const smokeRuntime = loadRuntime();
  const tempDir = mkdtempSync(join(tmpdir(), 'forgeax-smoke-runtime-test-'));
  let lockCalls = 0;
  try {
    const result = await smokeRuntime.runShard({
      identity: {runId: 'run-3', attempt: '1', job: 'smoke-play', pool: 'runner', shard: 'malformed-probe'},
      ports: [15890],
      command: [process.execPath, '-e', 'process.exit(0)'],
      lookupTool: tool => tool === 'flock' || tool === 'fuser',
      run: () => 'malformed probe output\n',
      runLockedCommand: async () => {
        lockCalls += 1;
        return {acquiredAt: '2026-01-01T00:00:00.000Z', code: 0, groupId: null, killedPids: []};
      },
      reportPath: join(tempDir, 'runtime.json'),
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.report.classification.code, smokeRuntime.FAILURE_CODES.portBusy);
    assert.equal(result.report.command.started, false);
    assert.equal(lockCalls, 0);
    assert.equal(result.report.ports.before[0].name, 'fuser:inspection-error');
  } finally {
    rmSync(tempDir, {recursive: true, force: true});
  }
});

test('admission fails closed when the lock and all port inspection tools are missing', async () => {
  const smokeRuntime = loadRuntime();
  const tempDir = mkdtempSync(join(tmpdir(), 'forgeax-smoke-runtime-test-'));
  try {
    const result = await smokeRuntime.runShard({
      identity: {runId: 'run-2', attempt: '1', job: 'smoke-play', pool: 'runner', shard: 'missing-tools'},
      ports: [15890],
      command: [process.execPath, '-e', 'process.exit(0)'],
      lookupTool: () => false,
      inspectPorts: () => { throw new Error('inspection must not run before admission'); },
      reportPath: join(tempDir, 'runtime.json'),
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.report.classification.code, smokeRuntime.FAILURE_CODES.admission);
    assert.deepEqual(result.report.admission.tools.missing, ['flock', 'port-inspection:lsof|fuser|ss']);
    assert.equal(result.report.command.started, false);
  } finally {
    rmSync(tempDir, {recursive: true, force: true});
  }
});

test('busy-port admission records the holder without authorizing an external kill', () => {
  const classifyFailure = loadClassifier();
  const result = classifyFailure(baseFailure({
    busyPorts: [{ port: 15890, pid: 71, command: 'vite', cwd: '/tmp/holder' }],
    killedPids: [],
    commandStarted: false,
  }));

  assertStructuredFailure(result, 'smoke-shard-port-busy');
  assert.equal(result.commandStarted, false);
  assert.deepEqual(result.killedPids, []);
  assert.match(JSON.stringify(result), /15890/);
  assert.match(JSON.stringify(result), /\/tmp\/holder/);
});

test('SIGKILL without OOM evidence remains an unknown service failure', () => {
  const classifyFailure = loadClassifier();
  const result = classifyFailure(baseFailure({
    lifecycleEvents: [{
      event: 'exited',
      service: 'standalone-host',
      pid: 71,
      code: null,
      signal: 'SIGKILL',
      shuttingDown: false,
    }],
  }));

  assertStructuredFailure(result, 'smoke-shard-service-sigkill');
  assert.match(result.observed, /unknown/i);
  assert.match(result.hint, /OOM|killer|runner/i);
});
