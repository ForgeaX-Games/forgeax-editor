import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { BUN_EXECUTABLE } from './bun-runtime.mjs';
import { packageCensusFromRoot } from './package-census.mjs';
import { classifyOwnership, validatePackageQuality } from './package-census-ownership.mjs';

export const PACKAGE_COVERAGE_SCHEMA_VERSION = 'forgeax-package-coverage/v1';
// Coverage instrumentation and serialized producers are intentionally slower
// than a normal package test. Keep this budget explicit instead of inheriting
// Bun's machine-sensitive 5s default.
export const PACKAGE_TEST_TIMEOUT_MS = 15_000;

function coverageError(code, expected, observed, hint) {
  return { code, expected, observed, hint };
}

function fail(code, expected, observed, hint) {
  return { ok: false, error: coverageError(code, expected, observed, hint) };
}

function parseCoverageText(text, { includeSource } = {}) {
  if (typeof text !== 'string' || !text.includes('end_of_record')) return fail('coverage-artifact-invalid', 'LCOV text with at least one record', text ?? 'missing', 'Run the package test producer with the LCOV reporter and retain its artifact.');
  const totals = { linesFound: 0, linesHit: 0, functionsFound: 0, functionsHit: 0 };
  for (const record of text.split('end_of_record')) {
    const lines = record.split('\n');
    const source = lines.find((line) => line.startsWith('SF:'))?.slice(3);
    if (includeSource && (!source || !includeSource(source))) continue;
    for (const line of lines) {
      if (line.startsWith('LF:')) totals.linesFound += Number(line.slice(3));
      if (line.startsWith('LH:')) totals.linesHit += Number(line.slice(3));
      if (line.startsWith('FNF:')) totals.functionsFound += Number(line.slice(4));
      if (line.startsWith('FNH:')) totals.functionsHit += Number(line.slice(4));
    }
  }
  if (![totals.linesFound, totals.linesHit, totals.functionsFound, totals.functionsHit].every(Number.isFinite)) {
    return fail('coverage-artifact-invalid', 'numeric LCOV line and function totals', totals, 'Repair the LCOV producer output before comparing package floors.');
  }
  if (totals.linesFound === 0 || totals.functionsFound === 0) return fail('coverage-dimension-missing', 'non-empty LCOV lines and functions dimensions', totals, 'Do not replace a missing package dimension with an aggregate result.');
  return {
    ok: true,
    lines: Number((100 * totals.linesHit / totals.linesFound).toFixed(2)),
    functions: Number((100 * totals.functionsHit / totals.functionsFound).toFixed(2)),
  };
}

export function parsePackageCoverageText(text, packageRoot, excludedRoots = []) {
  const root = resolve(packageRoot);
  const excluded = excludedRoots.map((path) => resolve(path));
  return parseCoverageText(text, {
    includeSource(source) {
      const sourcePath = resolve(root, source);
      return excluded.every((boundary) => {
        const boundaryPath = relative(boundary, sourcePath);
        return boundaryPath === '..' || boundaryPath.startsWith(`..${sep}`) || boundaryPath.startsWith('/');
      });
    },
  });
}

export function comparePackageCoverage(input) {
  const observed = input?.observed;
  if (!observed) return fail('coverage-result-missing', 'package coverage result', observed ?? 'missing', 'Run the package-specific test producer and retain its result.');
  if (typeof observed.packageName !== 'string' || !observed.packageName.trim()) return fail('coverage-package-identity-missing', input?.packageName ?? 'package identity', observed, 'Bind coverage to the manifest package name; aggregate evidence is not sufficient.');
  if (observed.packageName !== input.packageName) return fail('coverage-package-identity-mismatch', input.packageName, observed.packageName, 'Use the package identity from the manifest that produced this evidence.');
  if (typeof observed.lines !== 'number') return fail('coverage-lines-missing', 'numeric package lines coverage', observed.lines ?? 'missing', 'Emit the independent lines coverage dimension.');
  if (typeof observed.functions !== 'number') return fail('coverage-functions-missing', 'numeric package functions coverage', observed.functions ?? 'missing', 'Emit the independent functions coverage dimension.');
  if (typeof observed.lcovPath !== 'string' || !observed.lcovPath.trim()) return fail('coverage-artifact-missing', 'package LCOV path', observed.lcovPath ?? 'missing', 'Retain the LCOV artifact produced by this package test run.');
  if (observed.lines < input.floors.lines) return fail('coverage-lines-below-floor', input.floors.lines, observed.lines, 'Raise package lines coverage or update the floor from a reviewed clean baseline.');
  if (observed.functions < input.floors.functions) return fail('coverage-functions-below-floor', input.floors.functions, observed.functions, 'Raise package functions coverage or update the floor from a reviewed clean baseline.');
  return { ok: true, observed };
}

export function comparePackageCoverageBatch(inputs) {
  const observations = [];
  const errors = [];
  for (const input of inputs) {
    const comparison = comparePackageCoverage(input);
    observations.push({
      packageName: input.packageName,
      floors: input.floors,
      lines: input.observed?.lines,
      functions: input.observed?.functions,
    });
    if (!comparison.ok) errors.push({ packageName: input.packageName, error: comparison.error });
  }
  if (errors.length > 0) return { ok: false, error: errors[0].error, errors, observations };
  return { ok: true, observations };
}

function safeEvidencePath(path) {
  return typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.includes('..') && !path.includes('\\');
}

function evidenceDigest(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function buildCoverageBaseline(input, { readEvidence }) {
  if (typeof input?.runId !== 'string' || !input.runId.trim()) return fail('coverage-run-identity-missing', 'non-empty clean baseline runId', input?.runId ?? 'missing', 'Bind every clean baseline to one reproducible run identity.');
  if (!Array.isArray(input.records) || input.records.length === 0) return fail('coverage-baseline-empty', 'at least one package result', input.records ?? 'missing', 'Run every test-bearing package producer before creating the baseline.');
  const identities = new Set();
  const packages = [];
  for (const record of input.records) {
    if (typeof record.packageName !== 'string' || !record.packageName.trim()) return fail('coverage-package-identity-missing', 'packageName on every baseline result', record, 'Bind the test result to its manifest package name.');
    if (identities.has(record.packageName)) return fail('coverage-package-identity-duplicate', 'one baseline result per package identity', record.packageName, 'Remove the duplicate package result instead of merging evidence.');
    identities.add(record.packageName);
    if (!safeEvidencePath(record.lcovPath)) return fail('coverage-artifact-path-invalid', 'relative reproducible LCOV path', record.lcovPath ?? 'missing', 'Store package LCOV evidence below the declared evidence root.');
    let lcov;
    try {
      lcov = readEvidence(record.lcovPath);
    } catch {
      return fail('coverage-artifact-missing', record.lcovPath, 'unreadable', 'Preserve the LCOV artifact from the same package test run.');
    }
    const parsed = parseCoverageText(lcov);
    if (!parsed.ok) return parsed;
    if (typeof record.lines !== 'number' || typeof record.functions !== 'number') return fail('coverage-dimension-missing', 'lines and functions values on every package result', record, 'Persist both dimensions next to the package identity and LCOV path.');
    packages.push({
      packageName: record.packageName,
      lines: record.lines,
      functions: record.functions,
      lcovPath: record.lcovPath,
      lcovSha256: evidenceDigest(lcov),
      status: record.status ?? 'pass',
      failureSummary: record.failureSummary ?? null,
    });
  }
  packages.sort((left, right) => left.packageName.localeCompare(right.packageName));
  return { ok: true, baseline: { schemaVersion: PACKAGE_COVERAGE_SCHEMA_VERSION, runId: input.runId, packages } };
}

function commandForTest(testCommand) {
  const words = testCommand.trim().split(/\s+/);
  if (words[0] !== 'bun' || words[1] !== 'test') return fail('quality-test-command-unsupported', 'bun test package producer', testCommand, 'Use a Bun test entry so the producer can request independent LCOV output.');
  return { ok: true, args: words.slice(2) };
}

export function packageCoverageProducerArgs(testCommand, packageEvidence) {
  const command = commandForTest(testCommand);
  if (!command.ok) return command;
  const hasExplicitTimeout = command.args.some((arg) => arg === '--timeout' || arg.startsWith('--timeout='));
  return {
    ok: true,
    args: [
      ...command.args,
      ...(hasExplicitTimeout ? [] : [`--timeout=${PACKAGE_TEST_TIMEOUT_MS}`]),
      // Coverage is a quality baseline, so the producer must be deterministic.
      // Bun's default fan-out can observe different module initialization paths
      // when test files share process-global registries.
      '--max-concurrency=1',
      '--coverage',
      '--coverage-reporter=lcov',
      '--coverage-dir',
      packageEvidence,
      '--pass-with-no-tests',
    ],
  };
}

function parseLcovResult(packageName, lcovPath, text, packageRoot, excludedRoots) {
  const parsed = parsePackageCoverageText(text, packageRoot, excludedRoots);
  if (!parsed.ok) return parsed;
  return { ok: true, packageName, lines: parsed.lines, functions: parsed.functions, lcovPath, status: 'pass', failureSummary: null };
}

function runPackageProducer(rootDir, surface, evidenceRoot, excludedRoots) {
  const packagePath = resolve(rootDir, surface.path);
  const quality = surface.packageJson.forgeaxCi?.quality;
  const packageEvidence = join(evidenceRoot, surface.path.replaceAll('/', '__'));
  const command = packageCoverageProducerArgs(quality.test, packageEvidence);
  if (!command.ok) return command;
  const processResult = spawnSync(BUN_EXECUTABLE, ['test', ...command.args], { cwd: packagePath, encoding: 'utf8' });
  if (processResult.status !== 0) {
    return fail('package-test-failed', 'package test entry exits successfully', { packageName: surface.packageJson.name, status: processResult.status, stderr: processResult.stderr.slice(-4000) }, 'Fix the package test failure before publishing coverage evidence.');
  }
  const lcovAbsolute = join(packageEvidence, 'lcov.info');
  if (!existsSync(lcovAbsolute)) return fail('coverage-artifact-missing', lcovAbsolute, 'missing', 'Keep the LCOV artifact generated by the package-specific Bun test run.');
  const lcovPath = relative(evidenceRoot, lcovAbsolute).split(sep).join('/');
  return parseLcovResult(
    surface.packageJson.name,
    lcovPath,
    readFileSync(lcovAbsolute, 'utf8'),
    packagePath,
    excludedRoots,
  );
}

export function producePackageCoverage({ rootDir = process.cwd(), runId = 'local-package-coverage', evidenceRoot } = {}) {
  const census = packageCensusFromRoot(rootDir);
  if (census.status !== 'ready') return fail('coverage-census-admission', 'materialized workspace census', census, 'Materialize every workspace and gitlink input before producing package coverage.');
  const ownership = classifyOwnership(census);
  if (!ownership.ok) return ownership;
  const testBearing = ownership.surfaces.filter((surface) => surface.ownership === 'Editor-owned');
  const excludedRoots = [...new Set(
    ownership.surfaces
      .filter((surface) => surface.ownership === 'consumed-submodule-contract')
      .map((surface) => resolve(rootDir, surface.boundary)),
  )];
  const qualityErrors = [];
  for (const surface of testBearing) {
    const quality = validatePackageQuality(surface.packageJson, surface.testFiles ?? []);
    if (!quality.ok) qualityErrors.push({ path: surface.path, error: quality.error });
  }
  if (qualityErrors.length > 0) return fail('coverage-quality-admission', 'valid quality metadata for every Editor-owned package', qualityErrors, 'Add test and independent coverage obligations to every test-bearing package manifest.');
  const actualEvidenceRoot = evidenceRoot ?? mkdtempSync(join(tmpdir(), 'forgeax-package-coverage-'));
  const records = [];
  const comparisons = [];
  for (const surface of testBearing) {
    const record = runPackageProducer(rootDir, surface, actualEvidenceRoot, excludedRoots);
    if (!record.ok) return record;
    const floors = surface.packageJson.forgeaxCi.quality.coverage;
    records.push(record);
    comparisons.push({ packageName: surface.packageJson.name, floors, observed: record });
  }
  const coverageComparison = comparePackageCoverageBatch(comparisons);
  if (!coverageComparison.ok) return coverageComparison;
  const baseline = buildCoverageBaseline({ runId, records }, { readEvidence: (path) => readFileSync(join(actualEvidenceRoot, path), 'utf8') });
  if (!baseline.ok) return baseline;
  return { ok: true, census, baseline: baseline.baseline, evidenceRoot: actualEvidenceRoot };
}

function cliArgs(args) {
  const rootIndex = args.indexOf('--root-dir');
  const evidenceIndex = args.indexOf('--evidence-dir');
  return {
    rootDir: rootIndex === -1 ? process.cwd() : resolve(args[rootIndex + 1]),
    evidenceRoot: evidenceIndex === -1 ? undefined : resolve(args[evidenceIndex + 1]),
  };
}

if (import.meta.main) {
  const result = producePackageCoverage(cliArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}
