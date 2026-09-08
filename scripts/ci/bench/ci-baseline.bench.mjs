#!/usr/bin/env node

import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  deriveCostFacts,
  normalizeAttemptPacket,
} from '../ci-baseline.mjs';

const iterationsIndex = process.argv.indexOf('--iterations');
const iterations = Number(iterationsIndex >= 0 ? process.argv[iterationsIndex + 1] : 100);
if (!Number.isInteger(iterations) || iterations <= 0) {
  throw new Error('--iterations must be a positive integer');
}

const fixture = JSON.parse(readFileSync(resolve('scripts/ci/fixtures/ci-baseline-packet-cases.json'), 'utf8'));
const packet = fixture.cases.find((candidate) => candidate.name === 'complete attempt packet').packet;
const expectedJobNames = fixture.cases.find((candidate) => candidate.name === 'complete attempt packet').expectedJobNames;
const packetJsonBytes = Buffer.byteLength(JSON.stringify(packet));

function measure(action) {
  const start = performance.now();
  for (let index = 0; index < iterations; index += 1) action();
  return performance.now() - start;
}

const normalizationMs = measure(() => normalizeAttemptPacket(packet, {expectedJobNames}));
const normalized = normalizeAttemptPacket(packet, {expectedJobNames});
const repeatedReadMs = measure(() => {
  const reread = JSON.parse(JSON.stringify(packet));
  normalizeAttemptPacket(reread, {expectedJobNames});
});
const factsMs = measure(() => deriveCostFacts(normalized, {criticalPath: null, requiredContexts: []}));

process.stdout.write(`${JSON.stringify({
  schemaVersion: 'forgeax-ci-baseline/v2',
  status: 'measured',
  evidence: 'local-capacity-only',
  externalAcceptance: 'no-claim',
  requests: {
    packetApiRequests: 1,
    artifactApiRequests: 1,
    cacheApiRequests: 1,
    totalApiRequests: 3,
  },
  iterations,
  packetJsonBytes,
  normalizationMs,
  factsDerivationMs: factsMs,
  repeatedReadMs,
  repeatedReadOverheadMs: repeatedReadMs,
})}\n`);
