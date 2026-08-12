import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compareManifests } from '../chrome-performance-compare.mjs';

function summary(surface, displayed, renderer, extract, record) {
  return {
    surface,
    evidence: { status: 'VALID' },
    trace: {
      render: { displayedFrame: { intervals: { p95Ms: displayed } } },
      framePhases: {
        phases: { 'renderer-draw': { p95Ms: renderer } },
      },
      renderPhases: {
        phases: {
          extract: { p95Ms: extract },
          record: { p95Ms: record },
        },
      },
    },
  };
}

async function fixture(variant, value) {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-chrome-compare-'));
  const surfaces = ['edit', 'play-game'];
  const samples = [];
  for (const surface of surfaces) {
    const summaryPath = join(root, `${surface}.summary.json`);
    await writeFile(summaryPath, JSON.stringify(summary(surface, value, value - 1, value - 2, value - 3)));
    samples.push({
      repeat: 1,
      variant,
      surface,
      evidence: { status: 'VALID' },
      browserVersion: '151.0.7922.10',
      headed: true,
      traceCategories: 'devtools.timeline,blink.user_timing,gpu,viz',
      viewport: { dpr: 1, innerWidth: 1280, innerHeight: 720 },
      summaryPath,
      tracePath: `${surface}.trace.json`,
      summarySha256: `${variant}-${surface}-summary`,
      traceSha256: `${variant}-${surface}-trace`,
    });
  }
  return {
    root,
    manifest: {
      schemaVersion: 1,
      url: 'http://localhost:16090/',
      variant,
      headed: true,
      surfaceOrder: surfaces,
      repeatCount: 1,
      warmupMs: 20000,
      durationMs: 20000,
      freshBrowserPerSurface: true,
      samples,
    },
  };
}

describe('chrome performance comparison contract', () => {
  test('compares only matching VALID samples and reports aggregate deltas', async () => {
    const baseline = await fixture('baseline', 80);
    const candidate = await fixture('candidate', 60);
    try {
      const report = await compareManifests(baseline.manifest, candidate.manifest);
      expect(report.results).toHaveLength(2);
      expect(report.results[0].aggregate.displayedFrameP95Ms).toEqual({
        baselineMs: 80,
        candidateMs: 60,
        deltaMs: -20,
        deltaRatio: -0.25,
        candidateLower: true,
      });
    } finally {
      await Promise.all([rm(baseline.root, { recursive: true, force: true }), rm(candidate.root, { recursive: true, force: true })]);
    }
  });

  test('rejects mismatched schedule before reading summaries', async () => {
    const baseline = await fixture('baseline', 80);
    const candidate = await fixture('candidate', 60);
    candidate.manifest.durationMs = 30000;
    try {
      await expect(compareManifests(baseline.manifest, candidate.manifest)).rejects.toThrow('benchmark contracts differ');
    } finally {
      await Promise.all([rm(baseline.root, { recursive: true, force: true }), rm(candidate.root, { recursive: true, force: true })]);
    }
  });

  test('rejects a non-VALID sample instead of silently dropping it', async () => {
    const baseline = await fixture('baseline', 80);
    const candidate = await fixture('candidate', 60);
    candidate.manifest.samples[0].evidence.status = 'DIAGNOSTIC_ONLY';
    try {
      await expect(compareManifests(baseline.manifest, candidate.manifest)).rejects.toThrow('is not VALID');
    } finally {
      await Promise.all([rm(baseline.root, { recursive: true, force: true }), rm(candidate.root, { recursive: true, force: true })]);
    }
  });

  test('rejects a browser contract mismatch', async () => {
    const baseline = await fixture('baseline', 80);
    const candidate = await fixture('candidate', 60);
    candidate.manifest.samples[0].browserVersion = 'different-browser';
    try {
      await expect(compareManifests(baseline.manifest, candidate.manifest)).rejects.toThrow('benchmark contracts differ');
    } finally {
      await Promise.all([rm(baseline.root, { recursive: true, force: true }), rm(candidate.root, { recursive: true, force: true })]);
    }
  });
});
