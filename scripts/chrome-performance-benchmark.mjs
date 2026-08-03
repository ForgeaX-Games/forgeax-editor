#!/usr/bin/env node
// Fixed-schedule benchmark orchestrator for chrome-performance.mjs.
//
// Each surface is measured in a fresh child browser process. The child owns
// the real Gateway-driven state transition and Chrome trace contract; this
// wrapper only enforces schedule, provenance, and machine-readable aggregation.
// It intentionally measures one labeled variant at a time. A/B comparison is
// a separate experiment decision: run the same schedule for each pinned variant
// and compare only VALID summaries with the same machine/browser contract.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

const SURFACES = ['edit', 'play-scene', 'play-game'];
const DEFAULT_WARMUP_MS = 20000;
const DEFAULT_DURATION_MS = 20000;

function positiveNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive number`);
  return parsed;
}

function parseArgs(argv) {
  const flags = {
    url: process.env.FORGEAX_GATEWAY_URL ?? 'http://localhost:15290/',
    surface: 'all',
    repeat: 1,
    warmup: DEFAULT_WARMUP_MS,
    duration: DEFAULT_DURATION_MS,
    variant: 'baseline',
    headed: false,
    deepGpu: false,
    out: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--headed') flags.headed = true;
    else if (arg === '--deep-gpu') flags.deepGpu = true;
    else if (arg === '--url') flags.url = argv[++index];
    else if (arg === '--surface') flags.surface = argv[++index];
    else if (arg === '--repeat') flags.repeat = Math.floor(positiveNumber(argv[++index], '--repeat'));
    else if (arg === '--warmup') flags.warmup = positiveNumber(argv[++index], '--warmup');
    else if (arg === '--duration') flags.duration = positiveNumber(argv[++index], '--duration');
    else if (arg === '--variant') flags.variant = argv[++index];
    else if (arg === '--out') flags.out = argv[++index];
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: bun scripts/chrome-performance-benchmark.mjs --headed [--surface all|edit|play-scene|play-game] [--repeat n] [--warmup ms] [--duration ms] [--variant name] [--url url] [--out dir]');
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!SURFACES.includes(flags.surface) && flags.surface !== 'all') throw new Error(`--surface must be all or one of ${SURFACES.join(', ')}`);
  if (flags.warmup < DEFAULT_WARMUP_MS) throw new Error(`benchmark requires --warmup >= ${DEFAULT_WARMUP_MS}ms`);
  if (flags.duration < DEFAULT_DURATION_MS) throw new Error(`benchmark requires --duration >= ${DEFAULT_DURATION_MS}ms`);
  if (!/^[A-Za-z0-9._-]+$/.test(flags.variant)) throw new Error('--variant must contain only letters, numbers, dot, underscore, or hyphen');
  return flags;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function runChild(args, logPath) {
  return new Promise((resolveChild, reject) => {
    const child = spawn(process.execPath, args, { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', async (code, signal) => {
      const output = Buffer.concat(stdout).toString();
      const errorOutput = Buffer.concat(stderr).toString();
      await writeFile(logPath, `${output}\n--- stderr ---\n${errorOutput}`);
      if (code !== 0) {
        reject(new Error(`benchmark child failed (code=${code ?? 'null'}, signal=${signal ?? 'none'}): ${errorOutput.trim()}`));
        return;
      }
      resolveChild();
    });
  });
}

async function loadEvidence(summaryPath, tracePath) {
  const summaryText = await readFile(summaryPath, 'utf8');
  const summary = JSON.parse(summaryText);
  const traceText = await readFile(tracePath, 'utf8');
  return {
    surface: summary.surface,
    evidence: summary.evidence,
    framePhases: summary.trace?.framePhases ?? null,
    renderPhases: summary.trace?.renderPhases ?? null,
    browserVersion: summary.matrix?.browserVersion ?? null,
    headed: summary.matrix?.headed ?? null,
    traceCategories: summary.matrix?.traceCategories ?? null,
    viewport: {
      dpr: summary.matrix?.dom?.dpr ?? null,
      innerWidth: summary.matrix?.dom?.innerWidth ?? null,
      innerHeight: summary.matrix?.dom?.innerHeight ?? null,
    },
    summaryPath,
    tracePath,
    summarySha256: sha256(summaryText),
    traceSha256: sha256(traceText),
  };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = resolve(flags.out ?? join('/tmp/forgeax-chrome-performance', `benchmark-${stamp}`));
  await mkdir(outDir, { recursive: true });
  const surfaces = flags.surface === 'all' ? SURFACES : [flags.surface];
  const samples = [];
  const scriptPath = join(process.cwd(), 'scripts/chrome-performance.mjs');

  for (let repeat = 1; repeat <= flags.repeat; repeat += 1) {
    for (const surface of surfaces) {
      const sampleDir = join(outDir, flags.variant, `repeat-${String(repeat).padStart(2, '0')}`, surface);
      await mkdir(sampleDir, { recursive: true });
      const childArgs = [
        scriptPath,
        '--benchmark',
        '--surface', surface,
        '--warmup', String(flags.warmup),
        '--duration', String(flags.duration),
        '--url', flags.url,
        '--out', sampleDir,
        ...(flags.headed ? ['--headed'] : []),
        ...(flags.deepGpu ? ['--deep-gpu'] : []),
      ];
      await runChild(childArgs, join(sampleDir, 'child.log'));
      const evidence = await loadEvidence(join(sampleDir, `${surface}.summary.json`), join(sampleDir, `${surface}.trace.json`));
      if (evidence.evidence?.status !== 'VALID') {
        throw new Error(`${surface} repeat ${repeat} is not VALID: ${JSON.stringify(evidence.evidence?.invalidReasons ?? [])}`);
      }
      samples.push({ repeat, variant: flags.variant, ...evidence });
    }
  }

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    url: flags.url,
    variant: flags.variant,
    headed: flags.headed,
    surfaceOrder: surfaces,
    repeatCount: flags.repeat,
    warmupMs: flags.warmup,
    durationMs: flags.duration,
    freshBrowserPerSurface: true,
    samples,
    note: 'This is a fixed-schedule evidence set. Compare only VALID samples with matching provenance; it contains no optimization claim by itself.',
  };
  await writeFile(join(outDir, 'benchmark-manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`[chrome-performance-benchmark] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
