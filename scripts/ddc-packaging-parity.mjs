#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGING_PARITY_SCHEMA_VERSION = 'forgeax-ddc-packaging-parity/v1';
export const DEFAULT_PACKAGING_MODES = Object.freeze([
  'cold',
  'warm',
  'shared-disabled',
  'cache-unwritable',
]);
export const PACKAGING_MODES = DEFAULT_PACKAGING_MODES;

const SOURCE_SHA = /^[a-f0-9]{40}$/;
const ALLOWED_NONDTERMINISTIC_DEFAULTS = Object.freeze([
  'buildId',
  'createdAt',
  'durationMs',
]);
const DDC_SEGMENTS = new Set(['heads', 'current', 'lkg', 'leases', 'staging']);

function issue(code, expected, observed, hint, extra = {}) {
  return { code, expected, observed, hint, ...extra };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function canonicalizePackagingValue(value, allowedFields = []) {
  const visit = (entry, path) => {
    if (Array.isArray(entry)) return entry.map((child, index) => visit(child, `${path}[${index}]`));
    if (!entry || typeof entry !== 'object') return entry;
    const result = {};
    for (const [key, child] of Object.entries(entry)) {
      const childPath = path ? `${path}.${key}` : key;
      if (allowedFields.includes(key) || allowedFields.includes(childPath)) continue;
      result[key] = visit(child, childPath);
    }
    return result;
  };
  return visit(value, '');
}

function firstDifference(expected, actual, path = '') {
  if (stableStringify(expected) === stableStringify(actual)) return null;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    const length = Math.max(expected?.length ?? 0, actual?.length ?? 0);
    for (let index = 0; index < length; index += 1) {
      const difference = firstDifference(expected?.[index], actual?.[index], `${path}[${index}]`);
      if (difference) return difference;
    }
    return { field: path || '<root>', expected, observed: actual };
  }
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object') {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    for (const key of keys) {
      const difference = firstDifference(expected[key], actual[key], path ? `${path}.${key}` : key);
      if (difference) return difference;
    }
  }
  return { field: path || '<root>', expected, observed: actual };
}

export function comparePackagingModes(outputs, options = {}) {
  const modes = options.modes ?? DEFAULT_PACKAGING_MODES;
  const allowedNondeterministicFields = options.allowedNondeterministicFields ?? [];
  const differences = [];
  const baselineMode = modes[0];
  if (!baselineMode || !outputs || typeof outputs !== 'object') {
    return { ok: false, modes, differences: [issue('packaging-modes-invalid', 'mode output object', outputs, 'Provide one final output manifest for every declared mode.')] };
  }
  for (const mode of modes) {
    if (!outputs[mode]) {
      differences.push(issue('packaging-mode-missing', `output for ${mode}`, undefined, 'Run the mode to completion before comparing final artifacts.', { mode }));
    }
  }
  if (differences.length > 0) return { ok: false, modes, differences };

  const baseline = canonicalizePackagingValue(outputs[baselineMode], allowedNondeterministicFields);
  for (const mode of modes.slice(1)) {
    const candidate = canonicalizePackagingValue(outputs[mode], allowedNondeterministicFields);
    const difference = firstDifference(baseline, candidate);
    if (difference) {
      differences.push(issue(
        'packaging-output-mismatch',
        `${baselineMode} and ${mode} have equivalent final Pack/artifact/index output`,
        difference.observed,
        'Declare a genuinely nondeterministic field or repair the producer output; do not weaken the correctness comparison.',
        { mode, field: difference.field, expectedValue: difference.expected },
      ));
    }
  }
  return { ok: differences.length === 0, modes, differences };
}

function normalizeArchivePath(entry) {
  return entry.replaceAll('\\', '/').replace(/^\.\//, '');
}

function archiveReasons(entry) {
  const normalized = `/${normalizeArchivePath(entry).replace(/^\//, '')}/`;
  const reasons = [];
  if (normalized.includes('/.forgeax/ddc/')) reasons.push('.forgeax/ddc/');
  const segments = normalized.split('/').filter(Boolean).map((segment) => segment.toLowerCase());
  for (const segment of segments) {
    if (DDC_SEGMENTS.has(segment)) reasons.push(`/${segment}/`);
  }
  const base = segments.at(-1) ?? '';
  if (base === 'migration-report.json' || base.startsWith('migration-report.')) reasons.push('migration-report.json');
  return [...new Set(reasons)];
}

export function inventoryReleaseEntries(entries) {
  const flagged = [];
  const reasons = new Set();
  for (const entry of entries ?? []) {
    const entryReasons = archiveReasons(entry);
    if (entryReasons.length === 0) continue;
    flagged.push(normalizeArchivePath(entry));
    for (const reason of entryReasons) reasons.add(reason);
  }
  return { ok: flagged.length === 0, entries: flagged, reasons: [...reasons].sort() };
}

function walkFiles(root, current = root, result = []) {
  if (!existsSync(current)) return result;
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) walkFiles(root, path, result);
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

function sha256File(path) {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

function readJsonIfPresent(path) {
  if (extname(path) !== '.json') return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

export function finalOutputManifest(outDir, allowedNondeterministicFields) {
  const files = walkFiles(outDir);
  const entries = files.map((path) => {
    const relativePath = relative(outDir, path).split(sep).join('/');
    const parsed = readJsonIfPresent(path);
    const canonicalJson = parsed === undefined
      ? undefined
      : canonicalizePackagingValue(parsed, allowedNondeterministicFields);
    return {
      path: relativePath,
      // JSON byte metadata describes the canonical comparison body. Raw file
      // length includes fields intentionally removed from the comparison.
      bytes: canonicalJson === undefined
        ? statSync(path).size
        : Buffer.byteLength(stableStringify(canonicalJson)),
      digest: parsed === undefined
        ? sha256File(path)
        : `json:${createHash('sha256').update(stableStringify(canonicalJson)).digest('hex')}`,
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const packIndexPath = files.find((path) => relative(outDir, path).split(sep).join('/') === 'pack-index.json');
  const packIndex = packIndexPath === undefined ? null : readJsonIfPresent(packIndexPath);
  return {
    pack: entries.filter((entry) => entry.path.endsWith('.pack.json')),
    artifacts: entries.filter((entry) => entry.path !== 'pack-index.json'),
    packIndex,
    files: entries,
  };
}

function runBuild({ gameDir, outputDir, cacheRoot, projectDdcRoot, root, env }) {
  const command = process.execPath;
  const args = [join(root, 'scripts/fx.ts'), 'build', '--game', gameDir, '--out', outputDir];
  const result = spawnSync(command, args, {
    cwd: root,
    env: {
      ...process.env,
      ...env,
      FORGEAX_DDC_BUILD_CACHE_ROOT: cacheRoot,
      // Packaging parity is a disposable build-only consumer. Keep its
      // publication state beside the temporary output, never in the live
      // game's canonical .forgeax/ddc/v2 root that the following smoke uses.
      FORGEAX_DDC_PROJECT_ROOT: projectDdcRoot,
    },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  };
}

function sourceRevision(root) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function modeCacheRoot(modeRoot, mode) {
  return join(modeRoot, mode, 'build-cache');
}

function prepareUnwritableRoot(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'cache path intentionally occupies a file');
  return path;
}

function observeMode(mode, buildResult, outputDir, startedAt, fallback) {
  return {
    mode,
    status: buildResult.ok ? 'pass' : 'failure',
    cache: mode === 'cache-unwritable' ? 'unwritable' : 'available',
    fallback,
    durationMs: Date.now() - startedAt,
    bytes: walkFiles(outputDir).reduce((sum, path) => sum + statSync(path).size, 0),
    io: { reads: 'unavailable', writes: 'unavailable' },
    generation: 'unavailable',
    gc: 'unavailable',
    commandStatus: buildResult.status,
  };
}

export function validatePackagingParityReport(report) {
  const errors = [];
  const supportedSchemas = new Set([PACKAGING_PARITY_SCHEMA_VERSION, 'forgeax-ddc-packaging-report/v1']);
  if (!supportedSchemas.has(report?.schemaVersion)) {
    errors.push(issue('packaging-report-schema-invalid', [...supportedSchemas], report?.schemaVersion, 'Emit the versioned packaging report schema.'));
  }
  const revision = report?.sourceRevision ?? report?.revision;
  if (typeof revision !== 'string' || revision.length === 0 || (report?.sourceRevision !== undefined && !SOURCE_SHA.test(revision))) {
    errors.push(issue('packaging-source-revision-invalid', 'non-empty revision (40-character SHA for live runs)', revision, 'Bind the report to the exact current source revision.'));
  }
  const modeEntries = Array.isArray(report?.modes)
    ? Object.fromEntries(report.modes.map((entry) => [entry.mode, entry]))
    : report?.modes;
  const modeNames = modeEntries && typeof modeEntries === 'object' ? Object.keys(modeEntries) : [];
  if (JSON.stringify(modeNames) !== JSON.stringify(DEFAULT_PACKAGING_MODES)) {
    errors.push(issue('packaging-mode-roster-invalid', DEFAULT_PACKAGING_MODES, modeNames, 'Run cold, warm, shared-disabled, and cache-unwritable exactly once.'));
  }
  const allowedNondeterministicFields = report?.allowedNondeterministicFields ?? ALLOWED_NONDTERMINISTIC_DEFAULTS;
  const outputs = Object.fromEntries(DEFAULT_PACKAGING_MODES.map((mode) => [mode, modeEntries?.[mode]?.output ?? modeEntries?.[mode]]));
  const parity = report?.parity ?? comparePackagingModes(outputs, {
    modes: DEFAULT_PACKAGING_MODES,
    allowedNondeterministicFields,
  });
  if (!parity.ok || (parity.differences?.length ?? 0) !== 0) {
    const first = parity.differences?.[0];
    errors.push(issue(
      report?.parity === undefined ? 'packaging-output-mismatch' : 'packaging-parity-failed',
      'all four final outputs are equivalent',
      parity,
      'Repair the final artifact mismatch or declare only a genuine nondeterministic field.',
      { difference: first },
    ));
  }
  const archiveEntries = DEFAULT_PACKAGING_MODES.flatMap((mode) => modeEntries?.[mode]?.output?.archiveEntries ?? []);
  const archive = report?.archive ?? inventoryReleaseEntries(archiveEntries);
  if (!archive.ok || archive.entries?.length > 0) {
    errors.push(issue(
      report?.archive === undefined ? 'packaging-ddc-excluded' : 'release-ddc-inventory-nonempty',
      'final release contains no DDC state',
      archive,
      'Keep project DDC, lease, staging, and migration state outside final output.',
    ));
  }
  const unwritable = modeEntries?.['cache-unwritable'];
  const unwritablePath = unwritable?.path ?? unwritable?.fallback;
  const unwritableStatus = unwritable?.status ?? 'pass';
  if (unwritable && (unwritableStatus !== 'pass' || unwritablePath !== 'cold')) {
    errors.push(issue(
      Array.isArray(report?.modes) ? 'cache-unwritable-not-fail-open' : 'ddc-cache-not-fail-open',
      { status: 'pass', path: 'cold' },
      unwritable,
      'A cache failure may fall back to a cold build but must not block packaging.',
    ));
  }
  if (report?.observation !== undefined && report.observation.noClaim !== true) {
    errors.push(issue('performance-no-claim-missing', { noClaim: true }, report.observation, 'Performance observations must remain explicitly non-claiming.'));
  }
  if (report?.schemaVersion === PACKAGING_PARITY_SCHEMA_VERSION && report?.observation === undefined) {
    errors.push(issue('performance-no-claim-missing', { noClaim: true }, undefined, 'Live reports must include an explicit noClaim observation boundary.'));
  }
  return { ok: errors.length === 0, errors, modes: DEFAULT_PACKAGING_MODES, archiveDdcEntries: archiveEntries.filter((entry) => archiveReasons(entry).length > 0) };
}

export async function runPackagingParity({ gameDir, root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), outputRoot, keep = false } = {}) {
  if (!gameDir) throw new Error('gameDir is required');
  const absoluteGameDir = resolve(root, gameDir);
  const workRoot = outputRoot ? resolve(root, outputRoot) : mkdtempSync(join(tmpdir(), 'forgeax-ddc-packaging-'));
  mkdirSync(workRoot, { recursive: true });
  const outputs = {};
  const modeReports = [];
  const logs = [];
  const allowedNondeterministicFields = [...ALLOWED_NONDTERMINISTIC_DEFAULTS];

  for (const mode of DEFAULT_PACKAGING_MODES) {
    const modeRoot = join(workRoot, mode);
    const outputDir = join(modeRoot, 'dist');
    const projectDdcRoot = join(modeRoot, 'project-ddc');
    const cacheRoot = mode === 'cache-unwritable'
      ? prepareUnwritableRoot(modeCacheRoot(workRoot, mode))
      : modeCacheRoot(workRoot, mode);
    mkdirSync(modeRoot, { recursive: true });
    if (mode === 'warm') {
      const warmupOutput = join(modeRoot, 'warmup');
      const warmup = runBuild({
        gameDir: absoluteGameDir,
        outputDir: warmupOutput,
        cacheRoot,
        projectDdcRoot,
        root,
        env: {},
      });
      logs.push({ mode, phase: 'warmup', ...warmup });
      if (!warmup.ok) {
        return { ok: false, report: { schemaVersion: PACKAGING_PARITY_SCHEMA_VERSION, game: gameDir, sourceRevision: sourceRevision(root), modes: [], logs, error: 'warmup-failed' } };
      }
    }
    const startedAt = Date.now();
    let build = runBuild({
      gameDir: absoluteGameDir,
      outputDir,
      cacheRoot,
      projectDdcRoot,
      root,
      env: {},
    });
    let fallback = 'none';
    if (mode === 'cache-unwritable' && !build.ok) {
      const fallbackRoot = join(modeRoot, 'cold-fallback-cache');
      build = runBuild({
        gameDir: absoluteGameDir,
        outputDir,
        cacheRoot: fallbackRoot,
        projectDdcRoot,
        root,
        env: {},
      });
      fallback = 'cold';
    } else if (mode === 'cache-unwritable') {
      fallback = 'cold';
    }
    logs.push({ mode, phase: 'final', ...build });
    const modeReport = observeMode(mode, build, outputDir, startedAt, fallback);
    modeReports.push(modeReport);
    if (!build.ok) {
      return { ok: false, report: { schemaVersion: PACKAGING_PARITY_SCHEMA_VERSION, game: gameDir, sourceRevision: sourceRevision(root), modes: modeReports, logs, error: `${mode}-build-failed`, workRoot } };
    }
    outputs[mode] = finalOutputManifest(outputDir, allowedNondeterministicFields);
    if (mode === 'cache-unwritable') chmodSync(cacheRoot, 0o755);
  }

  const parity = comparePackagingModes(outputs, {
    modes: DEFAULT_PACKAGING_MODES,
    allowedNondeterministicFields,
  });
  const allFiles = Object.values(outputs).flatMap((manifest) => manifest.files.map((entry) => entry.path));
  const archive = inventoryReleaseEntries(allFiles);
  const report = {
    schemaVersion: PACKAGING_PARITY_SCHEMA_VERSION,
    game: gameDir,
    sourceRevision: sourceRevision(root),
    modes: modeReports,
    parity,
    archive,
    observation: {
      noClaim: true,
      sourceRevision: sourceRevision(root),
      fields: ['durationMs', 'bytes', 'io', 'generation', 'gc'],
      note: 'Measurements are same-revision observations only; no performance improvement or threshold is claimed.',
    },
    workRoot,
    logs,
  };
  const validation = validatePackagingParityReport(report);
  if (!keep && !outputRoot) rmSync(workRoot, { recursive: true, force: true });
  return { ok: validation.ok, report: { ...report, validation } };
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const prefix = `${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

async function main(args) {
  const gameDir = argumentValue(args, '--game');
  const unknown = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--game') {
      index += 1;
      continue;
    }
    if (arg === '--json' || arg === '--keep' || arg?.startsWith('--game=')) continue;
    unknown.push(arg);
  }
  if (!gameDir || unknown.length > 0) {
    console.error('usage: bun scripts/ddc-packaging-parity.mjs --game games/sample --json [--keep]');
    process.exitCode = 2;
    return;
  }
  const result = await runPackagingParity({ gameDir, keep: args.includes('--keep') });
  if (args.includes('--json')) console.log(JSON.stringify(result.report, null, 2));
  else console.log(result.ok ? 'packaging parity: pass' : 'packaging parity: failure');
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.main) await main(process.argv.slice(2));
