import {execFileSync, spawn, spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, readlinkSync, rmSync} from 'node:fs';
import {mkdir, rename, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';

export const RUNTIME_SCHEMA_VERSION = 'forgeax-smoke-shard-runtime/v1';
export const DEFAULT_LOCK_PATH = '/tmp/forgeax-heavy-browser.lock';
export const PORT_INSPECTION_TOOLS = Object.freeze(['lsof', 'fuser', 'ss']);
export const DEFAULT_REQUIRED_TOOLS = Object.freeze(['flock', ...PORT_INSPECTION_TOOLS]);
export const FAILURE_CODES = Object.freeze({
  admission: 'smoke-shard-admission-invalid',
  lockTimeout: 'smoke-shard-isolation-lock-timeout',
  portBusy: 'smoke-shard-port-busy',
  cgroupOom: 'smoke-shard-cgroup-oom',
  serviceSigkill: 'smoke-shard-service-sigkill',
  teardown: 'smoke-shard-teardown-residue',
  product: 'smoke-shard-product-or-unclassified-failure',
  passed: 'smoke-shard-passed',
});

const REQUIRED_IDENTITY = ['runId', 'attempt', 'job', 'pool', 'shard'];
function text(value, fallback = '') {
  return value === undefined || value === null ? fallback : String(value);
}

function now() {
  return new Date().toISOString();
}

function number(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function positivePorts(ports) {
  return [...new Set((ports ?? []).map(Number).filter(port => Number.isInteger(port) && port > 0 && port < 65536))];
}

export function validateIdentity(identity = {}) {
  const missing = REQUIRED_IDENTITY.filter(key => !text(identity[key]).trim());
  return {valid: missing.length === 0, missing};
}

export function validatePorts(ports) {
  const values = Array.isArray(ports) ? ports : [];
  const normalized = positivePorts(values);
  return {valid: values.length > 0 && normalized.length === values.length, ports: normalized};
}

function commandExists(command, lookup) {
  if (lookup) return Boolean(lookup(command));
  // Use a non-login shell so the lookup inherits the step's PATH (GITHUB_PATH +
  // system dirs). A login shell (`sh -lc`) re-sources /etc/profile and can reset
  // PATH on stripped self-hosted runners, hiding system tools (flock/lsof/...)
  // that provisioning just installed and breaking shard admission.
  return spawnSync('sh', ['-c', `command -v ${command}`], {stdio: 'ignore'}).status === 0;
}

export function validateTools(tools = DEFAULT_REQUIRED_TOOLS, lookup) {
  const requested = Array.isArray(tools) ? tools : DEFAULT_REQUIRED_TOOLS;
  const directRequirements = [...new Set(['flock', ...requested.filter(tool => !PORT_INSPECTION_TOOLS.includes(tool))])];
  const candidates = [...new Set([...directRequirements, ...PORT_INSPECTION_TOOLS])];
  const available = candidates.filter(tool => commandExists(tool, lookup));
  const portTool = PORT_INSPECTION_TOOLS.find(tool => available.includes(tool)) ?? null;
  const missing = directRequirements.filter(tool => !available.includes(tool));
  if (!portTool) missing.push(`port-inspection:${PORT_INSPECTION_TOOLS.join('|')}`);
  return {valid: missing.length === 0, missing, available, portTool};
}

function evidenceRefs(input) {
  const refs = Array.isArray(input.evidenceRefs) ? input.evidenceRefs : [];
  return refs.length > 0 ? refs : ['runtime.classification', 'runtime.resources', 'runtime.ports'];
}

function structuredFailure(code, expected, observed, hint, input = {}) {
  return {
    ...input,
    status: 'failure',
    code,
    expected,
    observed,
    hint,
    evidenceRefs: evidenceRefs(input),
  };
}

function signalWithoutShutdown(events = []) {
  return events.find(event => event?.signal === 'SIGKILL' && event.shuttingDown !== true);
}

export function classifyFailure(input = {}) {
  const lifecycleEvents = Array.isArray(input.lifecycleEvents) ? input.lifecycleEvents : [];
  if (input.admissionValid === false) {
    return structuredFailure(FAILURE_CODES.admission, 'required identity, tools, ports, and runner contract are valid', 'runtime admission is invalid', 'Fix the CI environment contract before starting the shard.', input);
  }
  if (input.lockTimedOut) {
    return structuredFailure(FAILURE_CODES.lockTimeout, 'the host-local heavy browser lock is acquired before the deadline', 'the lock wait deadline expired', 'Inspect the host lock holder and orphan process evidence; do not hide this with a rerun.', input);
  }
  if (Array.isArray(input.busyPorts) && input.busyPorts.length > 0) {
    return structuredFailure(FAILURE_CODES.portBusy, 'all declared ports are free before command start', `declared ports are already held: ${JSON.stringify(input.busyPorts)}`, 'Stop the owner of the shard port or choose the declared isolated environment; do not kill the holder.', input);
  }
  if (number(input.oomKillDelta) > 0) {
    return structuredFailure(FAILURE_CODES.cgroupOom, 'cgroup oom_kill does not increase during the shard', `cgroup oom_kill increased by ${input.oomKillDelta}`, 'Route the evidence to runner capacity ownership while preserving child and test artifacts.', input);
  }
  const killed = signalWithoutShutdown(lifecycleEvents);
  if (killed) {
    return structuredFailure(FAILURE_CODES.serviceSigkill, 'non-shutdown services do not exit with SIGKILL', `service ${text(killed.service, 'unknown')} exited with SIGKILL; cause is unknown`, 'Check an external killer or runner cleanup; do not relabel this as OOM without cgroup evidence.', input);
  }
  if ((input.processGroupResidue?.length ?? 0) > 0 || (input.portResidue?.length ?? 0) > 0) {
    return structuredFailure(FAILURE_CODES.teardown, 'owned process group and declared ports are quiet after teardown', `process residue=${JSON.stringify(input.processGroupResidue ?? [])}, port residue=${JSON.stringify(input.portResidue ?? [])}`, 'Fix process ownership and bounded teardown; never clean unrelated host processes.', input);
  }
  if (number(input.commandExitCode) !== 0) {
    return structuredFailure(FAILURE_CODES.product, 'the original smoke command exits with code 0', `the original smoke command exited with code ${text(input.commandExitCode)}`, 'Keep the original assertion and route the retained test evidence to its product owner.', input);
  }
  return {
    ...input,
    status: 'passed',
    code: FAILURE_CODES.passed,
    expected: 'the original smoke command exits cleanly with no resource or teardown signal',
    observed: 'the shard completed with no classified failure',
    hint: 'This only proves this shard; the smoke-play aggregate remains required.',
    evidenceRefs: evidenceRefs(input),
  };
}

export function parseLsof(output) {
  const holders = new Map();
  let current;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) current = {pid: Number(line.slice(1))};
    if (!current) continue;
    if (line.startsWith('c')) current.command = line.slice(1);
    if (line.startsWith('n')) current.name = line.slice(1);
    if (current.pid) holders.set(current.pid, current);
  }
  return [...holders.values()].map(holder => ({
    pid: holder.pid,
    command: holder.command ?? 'unknown',
    cwd: holder.cwd ?? 'unknown',
    name: holder.name,
  }));
}

export function parseFuser(output) {
  const holders = new Map();
  for (const line of text(output).split('\n')) {
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const name = line.slice(0, separator).trim();
    if (!/\b(?:tcp|udp)\b/i.test(name)) continue;
    for (const value of line.slice(separator + 1).match(/\b\d+\b/g) ?? []) {
      const pid = Number(value);
      if (pid > 0) holders.set(pid, {pid, command: 'unknown', name});
    }
  }
  return [...holders.values()];
}

export function parseSs(output) {
  const holders = [];
  const seen = new Set();
  for (const line of text(output).split('\n')) {
    if (!/\bLISTEN\b/.test(line)) continue;
    const command = line.match(/users:\(\("([^"]+)"/)?.[1] ?? 'unknown';
    const pids = [...line.matchAll(/pid=(\d+)/g)].map(match => Number(match[1])).filter(pid => pid > 0);
    if (pids.length === 0) {
      const key = `unknown:${line}`;
      if (!seen.has(key)) {
        seen.add(key);
        holders.push({pid: null, command, name: 'unknown'});
      }
      continue;
    }
    for (const pid of pids) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      holders.push({pid, command, name: 'unknown'});
    }
  }
  return holders;
}

function processCwd(pid, run, {platform = process.platform, readLink = readlinkSync} = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown';
  if (platform === 'linux') {
    try {
      const cwd = text(readLink(`/proc/${pid}/cwd`)).trim();
      if (cwd) return cwd;
    } catch {
      // /proc can be restricted; retain the lsof/unknown fallback below.
    }
  }
  try {
    const output = run('lsof', ['-nP', '-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
    return text(output).split('\n').find(line => line.startsWith('n'))?.slice(1) ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function runPortProbe(run, tool, port) {
  const args = tool === 'lsof'
    ? ['-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpcn']
    : tool === 'fuser'
      ? ['-n', 'tcp', String(port)]
      : ['-H', '-ltnp', `sport = :${port}`];
  try {
    return {status: 0, output: text(run(tool, args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}))};
  } catch (error) {
    const output = [text(error?.stdout), text(error?.stderr)].filter(Boolean).join('\n');
    return {status: Number.isInteger(error?.status) ? error.status : null, output};
  }
}

function inspectionError(port, tool) {
  return {port, pid: null, command: tool, cwd: 'unknown', name: `${tool}:inspection-error`};
}

function isExpectedEmptyProbe(tool, result) {
  return (tool === 'lsof' || tool === 'fuser') && result.status === 1 && result.output.trim() === '';
}

function parsePortProbe(tool, output) {
  if (tool === 'lsof') return parseLsof(output);
  if (tool === 'fuser') return parseFuser(output);
  return parseSs(output);
}

export function inspectPorts(ports, {
  run = execFileSync,
  lookupTool,
  portTool: configuredPortTool,
  platform = process.platform,
  readLink = readlinkSync,
} = {}) {
  const normalizedPorts = positivePorts(ports);
  const portTool = PORT_INSPECTION_TOOLS.includes(configuredPortTool)
    ? configuredPortTool
    : PORT_INSPECTION_TOOLS.find(tool => commandExists(tool, lookupTool)) ?? null;
  if (!portTool) return normalizedPorts.map(port => inspectionError(port, 'port-inspection-unavailable'));
  const holders = [];
  for (const port of normalizedPorts) {
    const result = runPortProbe(run, portTool, port);
    const parsed = result.status !== 0 && !isExpectedEmptyProbe(portTool, result)
      ? [inspectionError(port, portTool)]
      : parsePortProbe(portTool, result.output);
    const safeParsed = result.status === 0 && result.output.trim() !== '' && parsed.length === 0
      ? [inspectionError(port, portTool)]
      : parsed;
    for (const holder of safeParsed) {
      holders.push({port, ...holder, cwd: processCwd(holder.pid, run, {platform, readLink})});
    }
  }
  return holders;
}

function readIntegerFile(file) {
  try {
    const value = Number(readFileSync(file, 'utf8').trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function readResourceSnapshot({root = '/sys/fs/cgroup'} = {}) {
  const oomCandidates = [join(root, 'memory.events'), join(root, 'memory', 'memory.oom_control')];
  let oomKill = null;
  for (const file of oomCandidates) {
    try {
      const match = readFileSync(file, 'utf8').match(/(?:^|\n)oom_kill\s+(\d+)/);
      if (match) oomKill = Number(match[1]);
      if (oomKill === null) oomKill = readIntegerFile(file);
      if (oomKill !== null) break;
    } catch {
      // Cgroup telemetry is optional and must remain no-claim when unreadable.
    }
  }
  return {status: oomKill === null ? 'no-claim' : 'observed', oomKill, capturedAt: now()};
}

function groupMembers(groupId, {run = execFileSync} = {}) {
  if (!groupId) return [];
  try {
    const output = run('ps', ['-eo', 'pid=,pgid='], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
    return text(output).split('\n').flatMap(line => {
      const [pid, pgid] = line.trim().split(/\s+/).map(Number);
      return pgid === groupId && pid > 0 ? [pid] : [];
    });
  } catch {
    return [];
  }
}

function sendOwnedSignal(groupId, signal, members = groupMembers(groupId)) {
  if (!groupId || groupId === process.pid || members.length === 0) return [];
  try {
    process.kill(-groupId, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  return members;
}

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitForQuietPorts(ports, {quietMs = 250, pollMs = 50, inspect = inspectPorts} = {}) {
  const deadline = Date.now() + Math.max(quietMs, 0) + 5000;
  let quietSince = null;
  let last = [];
  while (Date.now() <= deadline) {
    last = inspect(ports);
    if (last.length === 0) {
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= quietMs) return {residue: [], observed: true};
    } else quietSince = null;
    await wait(pollMs);
  }
  return {residue: last, observed: false};
}

function environmentSnapshot(env) {
  return {
    runner: env.RUNNER_NAME ?? null,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    stateDir: env.CI_ENVIRONMENT_STATE_DIR ?? null,
    tmpDir: env.TMPDIR ?? null,
  };
}

function parseLifecycle(file) {
  if (!file) return [];
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

export function createReport(input = {}) {
  const classification = classifyFailure(input);
  return {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    identity: input.identity ?? {},
    admission: input.admission ?? {},
    lock: input.lock ?? {},
    environment: input.environment ?? {},
    ports: {before: input.portsBefore ?? [], after: input.portsAfter ?? []},
    resources: {
      before: input.resourcesBefore ?? {status: 'no-claim'},
      after: input.resourcesAfter ?? {status: 'no-claim'},
      delta: {oom_kill: input.oomKillDelta ?? null},
    },
    command: {...(input.command ?? {file: null, args: []}), started: input.commandStarted ?? false, exitCode: input.commandExitCode ?? null},
    lifecycleEvents: input.lifecycleEvents ?? [],
    classification,
    evidenceRefs: classification.evidenceRefs,
  };
}

export async function writeReportAtomic(report, reportPath) {
  await mkdir(dirname(reportPath), {recursive: true});
  const temporary = `${reportPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await rename(temporary, reportPath);
  return reportPath;
}

function identityFromEnv(env, shard) {
  return {
    runId: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT ?? '1',
    job: env.GITHUB_JOB,
    pool: env.RUNNER_GROUP ?? env.RUNNER_ENVIRONMENT ?? 'unknown',
    shard: shard ?? env.FORGEAX_SMOKE_SHARD ?? env.MATRIX_SHARD,
  };
}

function commandSpec(command) {
  if (Array.isArray(command) && command.length > 0) return {file: command[0], args: command.slice(1)};
  if (command?.file) return {file: command.file, args: command.args ?? []};
  return null;
}

async function terminateLockWaiter(child) {
  try { child.kill('SIGTERM'); } catch { /* waiter already exited */ }
  await new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, 1000);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function runLockedCommand(spec, options) {
  const markerDir = mkdtempSync(join(tmpdir(), 'forgeax-smoke-lock-'));
  const marker = join(markerDir, 'acquired-at');
  const env = {
    ...process.env,
    ...(options.env ?? {}),
    FORGEAX_RUNTIME_LOCK_MARKER: marker,
  };
  const holder = spawn('flock', [options.lockPath, 'sh', '-c', 'date -u +%Y-%m-%dT%H:%M:%S.%3NZ >"$FORGEAX_RUNTIME_LOCK_MARKER"; cat'], {env, stdio: ['pipe', 'ignore', 'ignore']});
  let holderError;
  holder.once('error', error => { holderError = error; });
  const deadline = Date.now() + options.lockTimeoutMs;
  let acquiredAt = null;
  while (Date.now() <= deadline) {
    try { acquiredAt = readFileSync(marker, 'utf8').trim() || null; } catch { /* wait for flock */ }
    if (acquiredAt || holderError || holder.exitCode !== null) break;
    await wait(25);
  }
  if (!acquiredAt) {
    await terminateLockWaiter(holder);
    rmSync(markerDir, {recursive: true, force: true});
    return {startedAt: now(), acquiredAt: null, releasedAt: now(), groupId: null, killedPids: [], code: holderError ? 127 : 75, signal: null, error: holderError};
  }
  const startedAt = now();
  const child = spawn(spec.file, spec.args, {detached: true, env, stdio: 'inherit'});
  const result = await new Promise(resolve => {
    child.once('error', error => resolve({code: 127, signal: null, error}));
    child.once('exit', (code, signal) => resolve({code: code ?? 1, signal}));
  });
  let killedPids = [];
  let members = groupMembers(child.pid);
  if (members.length > 0) {
    killedPids = sendOwnedSignal(child.pid, 'SIGTERM', members);
    await wait(options.teardownGraceMs);
    members = groupMembers(child.pid);
    if (members.length > 0) killedPids = [...new Set([...killedPids, ...sendOwnedSignal(child.pid, 'SIGKILL', members)])];
  }
  holder.stdin.end();
  await new Promise(resolve => holder.once('exit', resolve));
  rmSync(markerDir, {recursive: true, force: true});
  return {startedAt, acquiredAt, releasedAt: now(), groupId: child.pid, killedPids, ...result};
}

export async function runShard(options = {}) {
  const env = options.env ?? process.env;
  const identity = options.identity ?? identityFromEnv(env, options.shard);
  const ports = options.ports ?? [];
  const spec = commandSpec(options.command ?? options.commandArgs);
  const inspect = options.inspectPorts ?? inspectPorts;
  const toolCheck = validateTools(options.tools ?? DEFAULT_REQUIRED_TOOLS, options.lookupTool);
  const identityCheck = validateIdentity(identity);
  const portCheck = validatePorts(ports);
  const admissionValid = toolCheck.valid && identityCheck.valid && portCheck.valid && Boolean(spec);
  const common = {identity, environment: environmentSnapshot(env), command: spec ?? {file: null, args: []}, commandStarted: false, killedPids: [], evidenceRefs: ['runtime.admission', 'runtime.classification'], admission: {identity: identityCheck, tools: toolCheck, ports: portCheck}};
  const reportPath = options.reportPath ?? env.FORGEAX_SMOKE_RUNTIME_REPORT ?? (identity.shard ? join('.ci', 'smoke-shard-runtime', `${identity.shard}.json`) : null);
  if (!admissionValid) {
    const report = createReport({...common, admissionValid: false, commandExitCode: 1});
    if (reportPath) await writeReportAtomic(report, reportPath);
    return {exitCode: 1, report};
  }
  const inspectOptions = {...options, portTool: toolCheck.portTool};
  const portsBefore = inspect(ports, inspectOptions);
  if (portsBefore.length > 0) {
    const report = createReport({...common, admissionValid: true, busyPorts: portsBefore, commandExitCode: 1, portsBefore});
    if (reportPath) await writeReportAtomic(report, reportPath);
    return {exitCode: 1, report};
  }
  const resourcesBefore = readResourceSnapshot(options);
  const executeLockedCommand = options.runLockedCommand ?? runLockedCommand;
  const lock = await executeLockedCommand(spec, {lockPath: options.lockPath ?? env.FORGEAX_SMOKE_LOCK_PATH ?? DEFAULT_LOCK_PATH, lockTimeoutMs: options.lockTimeoutMs ?? 300000, teardownGraceMs: options.teardownGraceMs ?? 250, env});
  const commandStarted = Boolean(lock.acquiredAt);
  const resourcesAfter = readResourceSnapshot(options);
  const oomKillDelta = resourcesBefore.oomKill !== null && resourcesAfter.oomKill !== null ? resourcesAfter.oomKill - resourcesBefore.oomKill : null;
  const lifecycleEvents = options.lifecycleEvents ?? parseLifecycle(env.FORGEAX_DEV_STACK_EVENT_LOG);
  const quiet = await waitForQuietPorts(ports, {...options, inspect: candidatePorts => inspect(candidatePorts, inspectOptions)});
  const processGroupResidue = groupMembers(lock.groupId, options);
  const input = {...common, admissionValid: true, commandStarted, commandExitCode: lock.code, lockTimedOut: lock.code === 75, busyPorts: [], oomKillDelta, lifecycleEvents, processGroupResidue, portResidue: quiet.residue, portsBefore, portsAfter: quiet.residue, resourcesBefore, resourcesAfter, lock};
  const report = createReport(input);
  if (reportPath) await writeReportAtomic(report, reportPath);
  return {exitCode: report.classification.status === 'passed' ? 0 : 1, report};
}

function parseArgs(argv) {
  const options = {ports: [], command: []};
  const commandIndex = argv.indexOf('--');
  const flags = commandIndex === -1 ? argv : argv.slice(0, commandIndex);
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    const value = flags[index + 1];
    if (flag === '--shard') options.shard = value, index += 1;
    else if (flag === '--ports') options.ports = value.split(',').map(Number), index += 1;
    else if (flag === '--lock-path') options.lockPath = value, index += 1;
    else if (flag === '--report') options.reportPath = value, index += 1;
    else if (flag === '--lock-timeout-ms') options.lockTimeoutMs = Number(value), index += 1;
    else if (flag === '--quiet-ms') options.quietMs = Number(value), index += 1;
    else if (flag === '--identity') options.identity = JSON.parse(value), index += 1;
  }
  options.command = commandIndex === -1 ? [] : argv.slice(commandIndex + 1);
  return options;
}

const isMain = process.argv[1] && process.argv[1].endsWith('smoke-shard-runtime.mjs');
if (isMain) {
  const result = await runShard(parseArgs(process.argv.slice(2)));
  process.exitCode = result.exitCode;
}
