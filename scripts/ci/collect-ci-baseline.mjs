#!/usr/bin/env node
// Read-only baseline collector for frc-01.
//
// It reads workflow source at an explicitly supplied editor commit, reads the
// active GitHub ruleset, then fetches terminal push-to-main runs through the
// attempt-aware paginated jobs endpoint. Every response page is retained under
// the output directory. The collector is a census tool; it never edits GitHub
// state and never turns a small population into an SLO.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import {
  BASELINE_SCHEMA_VERSION,
  MINIMUM_STABLE_ROSTER,
  buildWorkflowGraph,
  comparableRunFilterReason,
  deriveTimings,
  extractRequiredContexts,
  flattenPaginatedArrayPages,
  flattenPaginatedObjects,
  normalizeAttemptJobPacket,
  stableRosterPopulation,
} from './ci-baseline.mjs';
import {
  ENGINE_TECHNIQUE_MIGRATION,
  validateEngineTechniqueMigration,
} from './engine-technique-migration.mjs';

const DEFAULT_REPO = 'ForgeaX-Games/forgeax-editor';
const DEFAULT_WORKFLOW = 'ci.yml';
const DEFAULT_LIMIT = 300;

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function positiveIntegerArgument(name, fallback) {
  const value = Number(argument(name, fallback));
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function gitOutput(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function gitShow(commit, path) {
  return execFileSync('git', ['show', `${commit}:${path}`], { encoding: 'utf8' });
}

function ghDetail(endpoint) {
  const output = execFileSync('gh', ['api', endpoint], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  return JSON.parse(output);
}

function ghPages(endpoint) {
  const output = execFileSync('gh', ['api', '--paginate', '--slurp', endpoint], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  return JSON.parse(output);
}

function workflowPathsAtCommit(commit) {
  return gitOutput(['ls-tree', '-r', '--name-only', commit, '--', '.github/workflows'])
    .split(/\r?\n/)
    .filter((path) => path.endsWith('.yml') || path.endsWith('.yaml'))
    .sort();
}

function selectRuleset(repo, requestedId) {
  if (requestedId) return ghDetail(`repos/${repo}/rulesets/${requestedId}`);
  const pages = ghPages(`repos/${repo}/rulesets?per_page=100`);
  const rulesets = flattenPaginatedArrayPages(pages, 'rulesets');
  const candidates = rulesets.filter((ruleset) =>
    ruleset?.enforcement === 'active' &&
    ruleset?.target === 'branch' &&
    (ruleset?.conditions?.ref_name?.include ?? []).some((value) =>
      value === '~DEFAULT_BRANCH' || value === 'refs/heads/main',
    ),
  );
  if (candidates.length !== 1) {
    throw new Error(`expected exactly one active main branch ruleset, found ${candidates.length}`);
  }
  return ghDetail(`repos/${repo}/rulesets/${candidates[0].id}`);
}

function normalizeRun(run) {
  return {
    id: run.id,
    runAttempt: run.run_attempt,
    event: run.event ?? null,
    branch: run.head_branch ?? null,
    status: run.status ?? null,
    conclusion: run.conclusion ?? null,
    headSha: run.head_sha ?? null,
    createdAt: run.created_at ?? null,
    runStartedAt: run.run_started_at ?? null,
    updatedAt: run.updated_at ?? null,
    url: run.html_url ?? null,
  };
}

function main() {
  const repo = argument('--repo', DEFAULT_REPO);
  const workflow = argument('--workflow', DEFAULT_WORKFLOW);
  const baselineCommit = argument('--baseline-commit', gitOutput(['rev-parse', 'HEAD']));
  const output = resolve(argument('--output', 'artifacts/ci-baseline'));
  const limit = positiveIntegerArgument('--limit', DEFAULT_LIMIT);
  const requestedRulesetId = argument('--ruleset-id');
  const collectorCommit = gitOutput(['rev-parse', 'HEAD']);

  mkdirSync(output, { recursive: true });
  validateEngineTechniqueMigration();

  const sourcePaths = workflowPathsAtCommit(baselineCommit);
  if (sourcePaths.length === 0) throw new Error(`no workflow files found at ${baselineCommit}`);
  const workflowSources = sourcePaths.map((path) => ({ file: path, text: gitShow(baselineCommit, path) }));

  const liveRuleset = selectRuleset(repo, requestedRulesetId);
  const requiredContexts = extractRequiredContexts(liveRuleset);
  const graph = buildWorkflowGraph(workflowSources, requiredContexts);
  writeJson(join(output, 'workflow-graph.json'), {
    ...graph,
    baselineCommit,
    sourceFiles: workflowSources.map(({ file, text }) => ({ file, sha256: sha256(text) })),
    liveRequiredContexts: requiredContexts,
  });
  writeJson(join(output, 'engine-technique-migration.json'), {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    rows: ENGINE_TECHNIQUE_MIGRATION,
  });

  const runPages = ghPages(`repos/${repo}/actions/workflows/${workflow}/runs?per_page=100`);
  const allRuns = flattenPaginatedObjects(runPages, 'workflow_runs');
  const candidates = allRuns
    .map((run) => ({ run, reason: comparableRunFilterReason(run) }))
    .filter(({ reason }) => reason === null)
    .slice(0, limit);
  const requiredJobContexts = graph.requiredContexts.map((context) => ({
    context: context.context,
    jobName: context.jobName,
  }));
  const workflowFile = sourcePaths.find((path) => path === `.github/workflows/${workflow}`);
  const admittedWorkflow = graph.workflows.find((candidate) => candidate.file === workflowFile);
  if (!admittedWorkflow) throw new Error(`workflow ${workflow} is not present at baseline ${baselineCommit}`);
  const expectedJobNames = admittedWorkflow.jobs.map((job) => job.name);
  const packetDirectory = join(output, 'job-packets');
  const packetRecords = [];
  const samples = [];

  for (const { run } of candidates) {
    const endpoint = `repos/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`;
    const packetPath = join(packetDirectory, `run-${run.id}-attempt-${run.run_attempt}.json`);
    try {
      const pages = ghPages(endpoint);
      writeJson(packetPath, {
        schemaVersion: BASELINE_SCHEMA_VERSION,
        endpoint,
        run: normalizeRun(run),
        pages,
      });
      const sample = normalizeAttemptJobPacket(run, pages, {
        requiredContexts: requiredJobContexts,
        expectedJobNames,
      });
      sample.packetPath = relative(output, packetPath);
      sample.timing = deriveTimings(sample, { requiredContexts: requiredJobContexts });
      samples.push(sample);
      packetRecords.push({
        runId: run.id,
        runAttempt: run.run_attempt,
        packetPath: relative(output, packetPath),
        status: 'accepted',
        jobCount: sample.jobCount,
        rosterKey: sample.rosterKey,
      });
    } catch (error) {
      packetRecords.push({
        runId: run.id,
        runAttempt: run.run_attempt,
        packetPath: relative(output, packetPath),
        status: 'rejected',
        code: error.code ?? 'packet-fetch-or-validation-failed',
        message: error.message,
      });
    }
  }

  const population = stableRosterPopulation(samples, {
    requiredContexts: requiredJobContexts,
    expectedJobNames,
    minimum: MINIMUM_STABLE_ROSTER,
  });
  const runRoster = {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    baselineCommit,
    repo,
    workflow,
    runQuery: `repos/${repo}/actions/workflows/${workflow}/runs?per_page=100`,
    jobQueryTemplate: `repos/${repo}/actions/runs/{run_id}/attempts/{run_attempt}/jobs?per_page=100`,
    runPagesPath: 'run-pages.json',
    totalRuns: allRuns.length,
    terminalComparableCandidates: candidates.length,
    runFilter: {
      event: 'push',
      branch: 'main',
      status: 'completed',
      conclusions: ['success', 'failure'],
      attemptAware: true,
      expectedJobNames,
    },
    runs: allRuns.map(normalizeRun),
    candidateRunIds: candidates.map(({ run }) => run.id),
    packetRecords,
    population,
  };
  writeJson(join(output, 'run-pages.json'), runPages);
  writeJson(join(output, 'run-roster.json'), runRoster);
  writeJson(join(output, 'run-samples.json'), samples);

  const baseline = {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    baselineCommit,
    collectorCommit,
    generatedAt: new Date().toISOString(),
    repo,
    workflow,
    source: {
      workflowFilesAtBaseline: sourcePaths,
      workflowGraphPath: 'workflow-graph.json',
      migrationMatrixPath: 'engine-technique-migration.json',
    },
    liveRuleset: {
      id: liveRuleset.id,
      name: liveRuleset.name ?? null,
      target: liveRuleset.target ?? null,
      enforcement: liveRuleset.enforcement ?? null,
      updatedAt: liveRuleset.updated_at ?? null,
      requiredContexts,
    },
    collection: {
      runRosterPath: 'run-roster.json',
      runPagesPath: 'run-pages.json',
      packetDirectory: 'job-packets',
      normalizedSamplesPath: 'run-samples.json',
      limit,
      packetMode: 'attempt-aware-paginated',
      paginationContract: 'gh api --paginate --slurp; total_count must equal flattened item count',
    },
    timingContract: {
      admission: 'run.run_started_at - run.created_at',
      queue: 'per required job started_at - created_at; queueSeconds is the maximum observed queue interval',
      active: 'latest required completed_at - earliest required started_at',
      firstFailure: 'first failed terminal job completed_at - run.run_started_at; null when no terminal job failed',
    },
    population,
    migrationMatrixPath: 'engine-technique-migration.json',
    sloClaim: null,
  };
  writeJson(join(output, 'ci-baseline.json'), baseline);

  process.stdout.write(`${JSON.stringify({
    status: 'collected',
    baselineCommit,
    output,
    totalRuns: allRuns.length,
    candidateRuns: candidates.length,
    acceptedPackets: samples.length,
    stableRosterCount: population.stableRosterCount,
    sufficientForSloPopulation: population.sufficientForSloPopulation,
    sloClaim: null,
  })}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`[ci-baseline] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
