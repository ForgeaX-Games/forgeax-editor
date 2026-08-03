#!/usr/bin/env node
// Compare two fixed-schedule Chrome performance manifests.
//
// This tool is intentionally analysis-only. It refuses to compare samples when
// the schedule, browser contract, surface set, or evidence status differs. A
// successful result is still not an optimization verdict: it reports deltas so
// the caller can apply the experiment's predeclared decision rule.

import { readFile, writeFile } from 'node:fs/promises';

const METRICS = [
  ['displayedFrameP95Ms', (summary) => summary.trace?.render?.displayedFrame?.intervals?.p95Ms],
  // renderer-draw is a Chrome frame phase; engine render phases (extract and
  // record) live beside it under the trace payload rather than inside it.
  ['rendererDrawP95Ms', (summary) => summary.trace?.framePhases?.phases?.['renderer-draw']?.p95Ms],
  ['extractP95Ms', (summary) => summary.trace?.renderPhases?.phases?.extract?.p95Ms],
  ['recordP95Ms', (summary) => summary.trace?.renderPhases?.phases?.record?.p95Ms],
];

function fail(message) {
  throw new Error(message);
}

function finiteMetric(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${label} is missing or non-finite`);
  }
  return value;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function sampleKey(sample) {
  return `${sample.repeat}:${sample.surface}`;
}

function sampleRuntimeContract(manifest) {
  return (manifest.samples ?? []).map((sample) => ({
    key: sampleKey(sample),
    browserVersion: sample.browserVersion ?? null,
    headed: sample.headed ?? null,
    traceCategories: sample.traceCategories ?? null,
    viewport: sample.viewport ?? null,
  })).sort((left, right) => left.key.localeCompare(right.key));
}

function manifestContract(manifest) {
  return {
    url: manifest.url,
    headed: manifest.headed,
    surfaceOrder: manifest.surfaceOrder,
    repeatCount: manifest.repeatCount,
    warmupMs: manifest.warmupMs,
    durationMs: manifest.durationMs,
    freshBrowserPerSurface: manifest.freshBrowserPerSurface,
    sampleRuntime: sampleRuntimeContract(manifest),
  };
}

function assertSameContract(baseline, candidate) {
  const left = manifestContract(baseline);
  const right = manifestContract(candidate);
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    fail(`benchmark contracts differ: ${JSON.stringify({ baseline: left, candidate: right })}`);
  }
}

function indexSamples(manifest, label) {
  if (manifest.freshBrowserPerSurface !== true) {
    fail(`${label} manifest must set freshBrowserPerSurface=true`);
  }
  if (!Array.isArray(manifest.samples) || manifest.samples.length === 0) {
    fail(`${label} manifest has no samples`);
  }
  const indexed = new Map();
  for (const sample of manifest.samples) {
    if (sample?.evidence?.status !== 'VALID') {
      fail(`${label} sample ${sampleKey(sample)} is not VALID`);
    }
    const key = sampleKey(sample);
    if (indexed.has(key)) fail(`${label} contains duplicate sample ${key}`);
    indexed.set(key, sample);
  }
  return indexed;
}

async function readSummary(sample, label) {
  if (typeof sample.summaryPath !== 'string' || sample.summaryPath.length === 0) {
    fail(`${label} sample ${sampleKey(sample)} has no summaryPath`);
  }
  const summary = JSON.parse(await readFile(sample.summaryPath, 'utf8'));
  if (summary.surface !== sample.surface) {
    fail(`${label} sample ${sampleKey(sample)} summary surface mismatch`);
  }
  if (summary.evidence?.status !== 'VALID') {
    fail(`${label} summary ${sample.summaryPath} is not VALID`);
  }
  return summary;
}

function compareMetric(name, baselineValue, candidateValue) {
  const deltaMs = candidateValue - baselineValue;
  return {
    baselineMs: baselineValue,
    candidateMs: candidateValue,
    deltaMs,
    deltaRatio: baselineValue === 0 ? null : deltaMs / baselineValue,
    candidateLower: candidateValue < baselineValue,
  };
}

/**
 * Compare two parsed benchmark manifests. The filesystem reads are kept here
 * rather than in the CLI so tests can prove the contract with small fixtures.
 */
export async function compareManifests(baseline, candidate, options = {}) {
  assertSameContract(baseline, candidate);
  if (baseline.variant === candidate.variant) {
    fail(`baseline and candidate must have different variants; got '${baseline.variant}'`);
  }

  const baselineSamples = indexSamples(baseline, 'baseline');
  const candidateSamples = indexSamples(candidate, 'candidate');
  const keys = [...baselineSamples.keys()].sort();
  const candidateKeys = [...candidateSamples.keys()].sort();
  if (JSON.stringify(keys) !== JSON.stringify(candidateKeys)) {
    fail(`sample sets differ: ${JSON.stringify({ baseline: keys, candidate: candidateKeys })}`);
  }

  const surfaces = options.surface === undefined || options.surface === 'all'
    ? [...new Set(keys.map((key) => key.slice(key.indexOf(':') + 1)))].sort()
    : [options.surface];
  const results = [];
  for (const surface of surfaces) {
    const pairs = keys.filter((key) => key.endsWith(`:${surface}`)).sort();
    if (pairs.length === 0) fail(`surface '${surface}' is absent from both manifests`);
    const perRepeat = [];
    for (const key of pairs) {
      const baselineSample = baselineSamples.get(key);
      const candidateSample = candidateSamples.get(key);
      const baselineSummary = await readSummary(baselineSample, 'baseline');
      const candidateSummary = await readSummary(candidateSample, 'candidate');
      const metrics = Object.fromEntries(METRICS.map(([name, read]) => [
        name,
        compareMetric(
          name,
          finiteMetric(read(baselineSummary), `baseline ${key} ${name}`),
          finiteMetric(read(candidateSummary), `candidate ${key} ${name}`),
        ),
      ]));
      perRepeat.push({ repeat: baselineSample.repeat, metrics });
    }

    const aggregate = {};
    for (const [name] of METRICS) {
      const baselineValues = perRepeat.map((item) => item.metrics[name].baselineMs);
      const candidateValues = perRepeat.map((item) => item.metrics[name].candidateMs);
      aggregate[name] = compareMetric(name, median(baselineValues), median(candidateValues));
    }
    results.push({ surface, repeatCount: perRepeat.length, perRepeat, aggregate });
  }

  return {
    schemaVersion: 1,
    analysis: 'fixed-schedule-chrome-delta',
    baseline: { variant: baseline.variant, manifestPath: baseline.manifestPath ?? null },
    candidate: { variant: candidate.variant, manifestPath: candidate.manifestPath ?? null },
    contract: manifestContract(baseline),
    results,
    note: 'Delta report only. It does not declare an optimization win; use a predeclared decision rule and retain matching RHI evidence separately.',
  };
}

async function readManifest(path, label) {
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  return { ...manifest, manifestPath: path, _label: label };
}

function parseArgs(argv) {
  const flags = { surface: 'all', out: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--baseline') flags.baseline = argv[++index];
    else if (arg === '--candidate') flags.candidate = argv[++index];
    else if (arg === '--surface') flags.surface = argv[++index];
    else if (arg === '--out') flags.out = argv[++index];
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: bun scripts/chrome-performance-compare.mjs --baseline <manifest.json> --candidate <manifest.json> [--surface all|edit|play-scene|play-game] [--out <report.json>]');
      process.exit(0);
    } else fail(`unknown argument: ${arg}`);
  }
  if (!flags.baseline || !flags.candidate) fail('--baseline and --candidate are required');
  return flags;
}

if (import.meta.main) {
  try {
    const flags = parseArgs(process.argv.slice(2));
    const report = await compareManifests(
      await readManifest(flags.baseline, 'baseline'),
      await readManifest(flags.candidate, 'candidate'),
      { surface: flags.surface },
    );
    const text = JSON.stringify(report, null, 2);
    if (flags.out) await writeFile(flags.out, `${text}\n`);
    console.log(text);
  } catch (error) {
    console.error(`[chrome-performance-compare] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
