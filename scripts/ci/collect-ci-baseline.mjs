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
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import {
  BASELINE_SCHEMA_VERSION,
  MINIMUM_STABLE_ROSTER,
  buildWorkflowGraph,
  comparableRunFilterReason,
  deriveCostFacts,
  deriveCriticalPath,
  deriveReadiness,
  deriveTimings,
  extractRequiredContexts,
  admitWorkflowTopology,
  flattenPaginatedArrayPages,
  flattenPaginatedObjects,
  normalizeAttemptJobPacket,
  normalizeAttemptPacket,
  successfulExactStableRosterPopulation,
  stableRosterPopulation,
  toStructuredError,
} from './ci-baseline.mjs';
import {
  ENGINE_TECHNIQUE_MIGRATION,
  validateEngineTechniqueMigration,
} from './engine-technique-migration.mjs';
import {deriveCapacityTimeline} from './collect-ci-capacity-admission.mjs';

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

function apiErrorObservation(error) {
  return {
    name: error?.name ?? 'Error',
    message: error instanceof Error ? error.message : String(error),
    ...(Number.isInteger(error?.status) ? {status: error.status} : {}),
    ...(error?.stderr ? {stderr: String(error.stderr).slice(-1000)} : {}),
  };
}

export function createCollectorRejection(error, {endpoint, run, baselineCommit, acceptedTopology} = {}) {
  const runId = run?.id ?? null;
  const runAttempt = run?.run_attempt ?? null;
  const sourceSha = baselineCommit ?? run?.head_sha ?? null;
  const topology = acceptedTopology ? {
    topologyId: acceptedTopology.topologyId ?? null,
    graphDigest: acceptedTopology.graphDigest ?? null,
    rosterKey: acceptedTopology.rosterKey ?? null,
    workflow: acceptedTopology.workflow ?? null,
  } : null;
  const api = apiErrorObservation(error);
  return {
    code: 'api-read-failed',
    expected: {
      endpoint,
      response: 'complete paginated API page',
      runId,
      runAttempt,
      sourceSha,
      topology,
    },
    observed: {
      endpoint,
      runId,
      runAttempt,
      sourceSha: run?.head_sha ?? null,
      api,
    },
    hint: 'Re-run the collector for this exact run attempt and endpoint; preserve the API response or failure envelope before deriving baseline facts.',
    affectedProvenance: {
      endpoint,
      run: {id: runId, attempt: runAttempt},
      sourceSha,
      topology,
    },
  };
}

function throwCollectorRejection(error, context) {
  const rejection = createCollectorRejection(error, context);
  const wrapped = new Error(`${rejection.code}: ${rejection.observed.api.message}`);
  Object.assign(wrapped, rejection);
  throw wrapped;
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

function optionalGhPages(endpoint, context = {}) {
  try {
    return ghPages(endpoint);
  } catch (error) {
    return {
      status: 'api-read-failed',
      endpoint,
      error: createCollectorRejection(error, {endpoint, ...context}),
    };
  }
}

function pageObservation(pages, endpoint) {
  if (pages === null || pages === undefined) return {status: 'missing-packet', endpoint};
  if (!Array.isArray(pages)) return {status: 'api-read-failed', endpoint, error: pages.error ?? {code: 'api-read-failed', message: 'API response was not a page array'}};
  return {status: 'valid', endpoint};
}

function noClaim(code, expected, observed, hint, affectedProvenance = null) {
  return {code, expected, observed, hint, affectedProvenance};
}

function jobTimingMap(sample) {
  return Object.fromEntries((sample.timing?.active?.byJob ?? []).map((timing) => [timing.name, timing]));
}

export function deriveAttemptEvidence(packet, {topology, requiredContexts, packetPath = null} = {}) {
  const jobTimings = jobTimingMap(packet);
  const criticalPath = deriveCriticalPath(topology, {jobTimings});
  const costFacts = deriveCostFacts(packet, {criticalPath, requiredContexts});
  const readiness = deriveReadiness(packet, packet.readinessObservations ?? {producer: null, consumers: []});
  return {
    attemptProvenance: packet.attemptProvenance,
    criticalPath,
    requiredContexts: {...topology.requiredContexts, attemptProvenance: packet.attemptProvenance},
    costFacts,
    readiness,
    capacityAdmission: packet.capacityAdmission ?? null,
    rawPacket: {available: true, path: packetPath},
  };
}

export function projectBaselineEvidence({
  baselineCommit,
  collectorCommit,
  repo,
  workflow,
  source,
  liveRuleset,
  acceptedTopology,
  samples,
  evidenceRecords,
  packetRecords,
  limit,
  runRoster,
}) {
  const first = evidenceRecords[0] ?? null;
  const acceptedTopologyIdentity = {
    topologyId: acceptedTopology.topologyId,
    graphDigest: acceptedTopology.graphDigest,
    rosterKey: acceptedTopology.rosterKey,
    workflow: acceptedTopology.workflow,
  };
  const budget = successfulExactStableRosterPopulation(samples, {
    acceptedTopology: acceptedTopologyIdentity,
    expectedJobNames: acceptedTopology.acceptedJobNames,
    expectedSourceSha: baselineCommit,
    owner: 'ci-baseline',
    successCondition: {
      runStatus: 'completed',
      runConclusion: 'success',
      jobStatus: 'completed',
      jobConclusion: 'success',
      label: 'completed run and every admitted job concluded success',
    },
  });
  const noClaims = [];
  const rejectedPacketClaims = packetRecords
    .filter((packet) => packet?.status === 'rejected' && packet.noClaim)
    .map((packet) => packet.noClaim);
  if (!first && rejectedPacketClaims.length === 0) {
    noClaims.push(noClaim(
      'attempt-packet-missing',
      'at least one complete current workflow run attempt packet',
      {acceptedPackets: 0, sourceSha: baselineCommit},
      'Collect the current source run, jobs, steps, runner, artifact, and cache pages before deriving facts.',
      {sourceSha: baselineCommit, topology: acceptedTopologyIdentity},
    ));
  }
  for (const evidence of evidenceRecords) {
    for (const block of [evidence.criticalPath, evidence.costFacts, evidence.readiness]) {
      if (block?.noClaim) noClaims.push(block.noClaim);
      if (block?.timing?.noClaim) noClaims.push(block.timing.noClaim);
      if (block?.acceptedPathTiming?.noClaim) noClaims.push(block.acceptedPathTiming.noClaim);
    }
  }
  noClaims.push(...rejectedPacketClaims);
  for (const evidence of evidenceRecords) {
    noClaims.push(...(evidence.capacityAdmission?.noClaim ?? []));
  }
  if (budget.noClaim) noClaims.push(budget.noClaim);
  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    baselineCommit,
    collectorCommit,
    generatedAt: new Date().toISOString(),
    repo,
    workflow,
    status: first ? 'collected' : 'no-claim',
    attemptProvenance: first?.attemptProvenance ?? null,
    criticalPath: first?.criticalPath ?? {status: 'no-claim', members: [], edges: [], timing: [], totalSeconds: null, noClaim: noClaims[0]},
    requiredContexts: first?.requiredContexts ?? {status: 'no-claim', contexts: [], records: [], noClaim: noClaims[0]},
    costFacts: first?.costFacts ?? {status: 'unknown', timing: {status: 'unknown'}, artifact: {status: 'unknown'}, cache: {status: 'unknown'}, noClaim: noClaims[0]},
    readiness: first?.readiness ?? {status: 'no-claim', delaySeconds: null, observations: [], noClaim: noClaims[0]},
    capacityAdmission: first?.capacityAdmission ?? {
      status: 'no-claim',
      admissible: false,
      noClaim: noClaims.filter((claim) => claim.code?.startsWith('job-') || claim.code?.startsWith('runner-') || claim.code?.startsWith('run-')),
    },
    budgetClaim: budget.budgetClaim,
    noClaim: noClaims,
    rawPacket: first?.rawPacket ?? {available: false, path: null},
    facts: {
      criticalPath: first?.criticalPath ?? null,
      requiredContexts: first?.requiredContexts ?? null,
      costFacts: first?.costFacts ?? null,
      readiness: first?.readiness ?? null,
      capacityAdmission: first?.capacityAdmission ?? null,
    },
    attempts: evidenceRecords,
    source: {
      ...source,
      acceptedTopology: acceptedTopologyIdentity,
      liveRuleset,
    },
    collection: {
      runRosterPath: 'run-roster.json',
      runPagesPath: 'run-pages.json',
      packetDirectory: 'job-packets',
      normalizedSamplesPath: 'run-samples.json',
      limit,
      packetMode: 'attempt-aware-paginated',
      paginationContract: 'gh api --paginate --slurp; total_count must equal flattened item count',
      rawPages: ['jobs', 'steps', 'artifacts', 'cache', 'runner'],
      attemptProvenance: 'one envelope per packet; retry attempts are never folded',
    },
    packetRecords,
    runRoster,
    population: budget,
    migrationMatrixPath: 'engine-technique-migration.json',
    sloClaim: null,
  };
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
  const candidates = rulesets
    .filter((ruleset) => ruleset?.enforcement === 'active' && ruleset?.target === 'branch')
    .map((ruleset) => ruleset?.conditions?.ref_name ? ruleset : ghDetail(`repos/${repo}/rulesets/${ruleset.id}`))
    .filter((ruleset) => (ruleset?.conditions?.ref_name?.include ?? []).some((value) =>
      value === '~DEFAULT_BRANCH' || value === 'refs/heads/main',
    ));
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

export function collectRunAttempt({run, repo, graph, requiredJobContexts, expectedJobNames, acceptedTopology, baselineCommit, output, workflowFile, admittedWorkflow, sourceFiles, liveRuleset, rulesetDigest, packetPath, readPages = ghPages, readOptionalPages = optionalGhPages}) {
  const endpoint = `repos/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`;
  const artifactEndpoint = `repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`;
  const cacheEndpoint = `repos/${repo}/actions/caches?ref=refs/heads/main&per_page=100`;
  let jobsPages;
  try {
    jobsPages = readPages(endpoint);
  } catch (error) {
    throwCollectorRejection(error, {endpoint, run, baselineCommit, acceptedTopology});
  }
  const pageContext = {run, baselineCommit, acceptedTopology};
  const artifactPages = readOptionalPages(artifactEndpoint, pageContext);
  const cachePages = readOptionalPages(cacheEndpoint, pageContext);
  const rawJobs = flattenPaginatedObjects(jobsPages, 'jobs');
  const observedJobNames = rawJobs
    .filter((job) => job?.conclusion !== 'skipped')
    .map((job) => job?.name)
    .filter((name) => typeof name === 'string' && name.length > 0);
  const topology = admitWorkflowTopology(graph, {
    requiredContexts: requiredJobContexts,
    observedJobNames,
    expandMatrix: true,
    workflowFile,
  });
  const acceptedNames = new Set(topology.acceptedJobNames);
  const admittedJobCount = rawJobs.filter((job) => acceptedNames.has(job?.name)).length;
  const admittedJobsPages = jobsPages.map((page) => ({
    ...page,
    total_count: admittedJobCount,
    jobs: page.jobs.filter((job) => acceptedNames.has(job?.name)),
  }));
  const jobSample = normalizeAttemptJobPacket(run, admittedJobsPages, {
    requiredContexts: requiredJobContexts,
    expectedJobNames: topology.acceptedJobNames ?? expectedJobNames,
  });
  const attemptProvenance = {
    sourceSha: run.head_sha,
    runId: run.id,
    runAttempt: run.run_attempt,
    topologyId: topology.topologyId,
    graphDigest: topology.graphDigest,
    rosterKey: jobSample.rosterKey,
    workflow: {file: workflowFile, name: admittedWorkflow.name},
  };
  const cacheObservation = pageObservation(cachePages, cacheEndpoint);
  const packetInput = {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    endpoint,
    artifactEndpoint,
    cacheEndpoint,
    run,
    sourceSha: run.head_sha,
    workflowFiles: sourceFiles,
    ruleset: {id: liveRuleset.id, sha256: rulesetDigest},
    attemptProvenance,
    jobsPages: admittedJobsPages,
    artifactPages,
    cachePages,
    artifacts: Array.isArray(artifactPages) ? flattenPaginatedObjects(artifactPages, 'artifacts') : [],
    artifactObservation: pageObservation(artifactPages, artifactEndpoint),
    cache: {
      status: 'unknown',
      observationState: cacheObservation.status === 'api-read-failed' ? 'api-read-failed' : cacheObservation.status === 'missing-packet' ? 'missing-packet' : 'valid-unknown',
      endpoint: cacheEndpoint,
      ...(cachePages?.error ? {error: cachePages.error} : {}),
    },
    rawPages: {jobs: jobsPages, artifacts: artifactPages, cache: cachePages},
  };
  const capacityAdmission = deriveCapacityTimeline({
    run,
    jobs: rawJobs.filter((job) => acceptedNames.has(job?.name)),
    artifacts: Array.isArray(artifactPages) ? flattenPaginatedObjects(artifactPages, 'artifacts') : [],
    topology,
    sourceSha: baselineCommit,
    workflow: {file: workflowFile, name: admittedWorkflow.name},
    sourceFiles,
    ruleset: {id: liveRuleset.id, digest: rulesetDigest},
  });
  packetInput.capacityAdmission = capacityAdmission;
  writeJson(packetPath, packetInput);
  const sample = normalizeAttemptPacket(packetInput, {
    requiredContexts: requiredJobContexts,
    expectedJobNames,
    attemptProvenance,
    acceptedTopology: {...acceptedTopology, ...topology},
    expectedWorkflow: {file: workflowFile, name: admittedWorkflow.name},
    expectedSourceSha: baselineCommit,
    expectedRuleset: {id: liveRuleset.id, sha256: rulesetDigest},
  });
  sample.capacityAdmission = capacityAdmission;
  sample.packetPath = relative(output, packetPath);
  sample.timing = deriveTimings(sample, {requiredContexts: requiredJobContexts});
  const evidence = deriveAttemptEvidence(sample, {
    topology: {...topology, attemptProvenance},
    requiredContexts: requiredJobContexts,
    packetPath: sample.packetPath,
  });
  return {
    sample,
    evidence,
    record: {
      runId: run.id,
      runAttempt: run.run_attempt,
      packetPath: relative(output, packetPath),
      status: 'accepted',
      jobCount: sample.jobCount,
      rosterKey: sample.rosterKey,
      packetProvenance: sample.attemptProvenance,
      evidence: {
        criticalPath: evidence.criticalPath.status,
        costFacts: evidence.costFacts.status,
        readiness: evidence.readiness.status,
        capacityAdmission: evidence.capacityAdmission?.status ?? 'missing',
      },
    },
  };
}

export function main() {
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
  const sourceFiles = workflowSources.map(({ file, text }) => ({ file, sha256: sha256(text) }));
  const rulesetDigest = sha256(JSON.stringify(liveRuleset));
  writeJson(join(output, 'workflow-graph.json'), {
    ...graph,
    baselineCommit,
    sourceFiles,
    sourceSha: baselineCommit,
    ruleset: {id: liveRuleset.id, sha256: rulesetDigest},
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
  const sourceTopology = admitWorkflowTopology(graph, {requiredContexts, expandMatrix: true, workflowFile});
  const acceptedTopology = {
    ...sourceTopology,
    workflow: {file: workflowFile, name: admittedWorkflow.name},
  };
  const expectedJobNames = acceptedTopology.acceptedJobNames;
  const packetDirectory = join(output, 'job-packets');
  const packetRecords = [];
  const samples = [];
  const evidenceRecords = [];

  for (const { run } of candidates) {
    const packetPath = join(packetDirectory, `run-${run.id}-attempt-${run.run_attempt}.json`);
    try {
      const result = collectRunAttempt({
        run,
        repo,
        graph,
        requiredJobContexts,
        expectedJobNames,
        acceptedTopology,
        baselineCommit,
        output,
        workflowFile,
        admittedWorkflow,
        sourceFiles,
        liveRuleset,
        rulesetDigest,
        packetPath,
      });
      samples.push(result.sample);
      evidenceRecords.push(result.evidence);
      packetRecords.push(result.record);
    } catch (error) {
      const rejection = toStructuredError(error);
      packetRecords.push({
        runId: run.id,
        runAttempt: run.run_attempt,
        packetPath: relative(output, packetPath),
        status: 'rejected',
        code: rejection.code,
        message: error.message,
        noClaim: rejection,
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
  const baseline = projectBaselineEvidence({
    baselineCommit,
    collectorCommit,
    repo,
    workflow,
    source: {
      sourceSha: baselineCommit,
      workflowFilesAtBaseline: sourcePaths,
      workflowGraphPath: 'workflow-graph.json',
      migrationMatrixPath: 'engine-technique-migration.json',
      workflowFileDigests: sourceFiles,
      rulesetDigest,
    },
    liveRuleset: {
      id: liveRuleset.id,
      name: liveRuleset.name ?? null,
      target: liveRuleset.target ?? null,
      enforcement: liveRuleset.enforcement ?? null,
      updatedAt: liveRuleset.updated_at ?? null,
      requiredContexts,
    },
    acceptedTopology,
    samples,
    evidenceRecords,
    packetRecords,
    limit,
    runRoster,
  });
  baseline.timingContract = {
    admission: 'run.run_started_at - run.created_at',
    queue: 'per required job started_at - created_at; queueSeconds is the maximum observed queue interval',
    active: 'latest required completed_at - earliest required started_at',
    firstFailure: 'first failed terminal job completed_at - run.run_started_at; null when no terminal job failed',
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
    status: baseline.status,
    noClaim: baseline.noClaim,
    sloClaim: null,
  })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[ci-baseline] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
