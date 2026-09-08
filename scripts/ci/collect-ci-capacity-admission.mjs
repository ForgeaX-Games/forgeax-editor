#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import {
  BASELINE_SCHEMA_VERSION,
  admitWorkflowTopology,
  buildWorkflowGraph,
  extractRequiredContexts,
  flattenPaginatedObjects,
} from './ci-baseline.mjs';

export const CAPACITY_SCHEMA_VERSION = 'forgeax-ci-capacity-admission/v1';
export const CAPACITY_PHASES = Object.freeze([
  'workflow-created',
  'dependency-ready',
  'matrix-throttle',
  'runner-assigned',
  'setup-active',
  'task-active',
  'aggregate',
  'terminal',
  'artifact-ready',
]);
const TERMINAL_FAILURES = new Set([
  'action_required',
  'cancelled',
  'failure',
  'startup_failure',
  'timed_out',
]);
const SETUP_WORDS = /\b(admission|artifact|checkout|complete|download|environment|establish|hydrate|install|node(?:\.js)?|prepare|produce|recover|record|route|setup|upload|validate|verify|post )\b/i;
const TASK_WORDS = /\b(broad|create game|default-scene|editor smoke|play|repro|scriptablepack|self-boot b2|smoke|test|typecheck|vfx)\b/i;

function timestamp(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function iso(milliseconds) {
  return !Number.isFinite(milliseconds) ? null : new Date(milliseconds).toISOString();
}

function seconds(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Number(((end - start) / 1000).toFixed(6));
}

function firstDefined(...values) {
  return values.find((value) => value !== null && value !== undefined) ?? null;
}

function jobField(job, camel, raw) {
  return firstDefined(job?.[camel], job?.[raw]);
}

function labelsOf(job) {
  const labels = Array.isArray(job?.labels) ? job.labels : [];
  return labels
    .map((label) => typeof label === 'string' ? label : label?.name)
    .filter((label) => typeof label === 'string' && label.length > 0)
    .sort();
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return `sha256:${createHash('sha256').update(`${stableJson(value)}\n`).digest('hex')}`;
}

function textDigest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function noClaim(code, expected, observed, hint, affectedProvenance = null) {
  return {code, expected, observed, hint, affectedProvenance};
}

function normalizedStep(step) {
  return {
    name: typeof step?.name === 'string' ? step.name : null,
    conclusion: typeof step?.conclusion === 'string' ? step.conclusion : null,
    startedAt: jobField(step, 'startedAt', 'started_at'),
    completedAt: jobField(step, 'completedAt', 'completed_at'),
  };
}

function normalizedJob(job, definition, run) {
  const createdAt = jobField(job, 'createdAt', 'created_at');
  const startedAt = jobField(job, 'startedAt', 'started_at');
  const completedAt = jobField(job, 'completedAt', 'completed_at');
  return {
    id: firstDefined(job?.id, job?.jobId),
    name: firstDefined(job?.name, job?.jobName),
    status: firstDefined(job?.status, job?.state),
    conclusion: firstDefined(job?.conclusion, job?.result),
    runId: firstDefined(job?.runId, job?.run_id, run?.id),
    runAttempt: firstDefined(job?.runAttempt, job?.run_attempt, run?.run_attempt),
    createdAt,
    startedAt,
    completedAt,
    runnerId: firstDefined(job?.runnerId, job?.runner_id),
    runnerName: firstDefined(job?.runnerName, job?.runner_name),
    runnerGroupId: firstDefined(job?.runnerGroupId, job?.runner_group_id),
    labels: labelsOf(job),
    steps: (Array.isArray(job?.steps) ? job.steps : []).map(normalizedStep),
    definition,
  };
}

function phase(kind, start, end, extra = {}) {
  const startMs = timestamp(start);
  const endMs = timestamp(end ?? start);
  return {
    kind,
    status: startMs !== null && endMs !== null && endMs >= startMs ? 'observed' : 'no-claim',
    startAt: startMs === null ? null : iso(startMs),
    endAt: endMs === null ? null : iso(endMs),
    durationSeconds: startMs !== null && endMs !== null && endMs >= startMs ? seconds(startMs, endMs) : null,
    ...extra,
  };
}

function eventPhase(kind, at, extra = {}) {
  return phase(kind, at, at, {...extra, observation: extra.observation ?? 'point-boundary'});
}

function incomingEdges(topology, name) {
  return (topology?.needsEdges ?? []).filter((edge) => edge.to === name);
}

function taskStep(step) {
  if (!step.name) return false;
  if (SETUP_WORDS.test(step.name)) return false;
  return TASK_WORDS.test(step.name);
}

function stepWindow(step) {
  const start = timestamp(step.startedAt);
  const end = timestamp(step.completedAt ?? step.startedAt);
  if (start === null || end === null || end < start) return null;
  return {start, end};
}

function classifyStepPhases(job) {
  const taskSteps = job.steps.filter(taskStep).map((step) => ({step, window: stepWindow(step)})).filter((entry) => entry.window);
  const firstTask = taskSteps[0]?.window ?? null;
  const lastTask = taskSteps.at(-1)?.window ?? null;
  const setup = firstTask
    ? phase('setup-active', job.startedAt, iso(firstTask.start), {
      basis: 'job.started_at to first product/task step',
      stepNames: job.steps.filter((step) => {
        const window = stepWindow(step);
        return window && window.start < firstTask.start;
      }).map((step) => step.name),
    })
    : phase('setup-active', job.startedAt, job.completedAt, {
      status: 'no-claim',
      noClaim: 'task-step-not-identified',
      basis: 'step names did not identify a product/task boundary',
    });
  const task = taskSteps.length > 0
    ? phase('task-active', iso(firstTask.start), iso(lastTask.end), {
      stepNames: taskSteps.map(({step}) => step.name),
      stepIntervals: taskSteps.map(({step, window}) => ({name: step.name, startAt: iso(window.start), endAt: iso(window.end), durationSeconds: seconds(window.start, window.end)})),
    })
    : phase('task-active', job.startedAt, job.completedAt, {
      status: 'no-claim',
      noClaim: 'task-step-not-identified',
    });
  return {setup, task};
}

function runnerProjection(job) {
  const pools = job.labels.filter((label) => label === 'standard' || label === 'heavy');
  return {
    id: job.runnerId ?? null,
    name: job.runnerName ?? null,
    groupId: job.runnerGroupId ?? null,
    labels: job.labels,
    pool: pools.length === 1 ? pools[0] : null,
  };
}

function runnerIdentityIssue(job) {
  if (job.conclusion === 'skipped') return null;
  if (job.runnerId === null || job.runnerName === null || job.labels.length === 0) return 'runner-identity-missing';
  const pools = job.labels.filter((label) => label === 'standard' || label === 'heavy');
  return pools.length === 1 ? null : 'runner-pool-label-invalid';
}

function jobIntervals(jobs, topology) {
  return jobs.map((job) => {
    const start = timestamp(job.startedAt);
    const end = timestamp(job.completedAt);
    return {
      name: job.name,
      start,
      end,
      pool: runnerProjection(job).pool ?? job.definition?.runner?.pool ?? null,
      sourceName: job.definition?.sourceName ?? job.definition?.name ?? job.name,
      maxParallel: job.definition?.strategy?.maxParallel ?? null,
      matrixValues: job.definition?.matrixValues ?? {},
      runner: runnerProjection(job),
      identity: {runId: job.runId ?? null, runAttempt: job.runAttempt ?? null, jobId: job.id ?? null, name: job.name},
      incoming: incomingEdges(topology, job.name),
    };
  });
}

function temporalSegments(intervals) {
  const events = intervals.flatMap((interval) => [
    {time: interval.start, type: 'end-before-start', delta: 1, interval},
    {time: interval.end, type: 'end', delta: -1, interval},
  ]).filter((event) => Number.isFinite(event.time));
  events.sort((left, right) => left.time - right.time || left.delta - right.delta);
  const active = new Map();
  const segments = [];
  let cursor = events[0]?.time ?? null;
  for (const event of events) {
    if (cursor !== null && event.time > cursor && active.size > 0) {
      const values = [...active.values()];
      segments.push({
        startAt: iso(cursor),
        endAt: iso(event.time),
        durationSeconds: seconds(cursor, event.time),
        concurrency: values.length,
        jobs: values.map((value) => value.name).sort(),
        runnerNames: [...new Set(values.map((value) => value.runner.name).filter(Boolean))].sort(),
        runnerIds: [...new Set(values.map((value) => value.runner.id).filter((value) => value !== null))].sort((a, b) => a - b),
      });
    }
    if (event.type === 'end') active.delete(event.interval.name);
    else active.set(event.interval.name, event.interval);
    cursor = event.time;
  }
  return segments;
}

function matrixGroups(intervals) {
  const groups = new Map();
  for (const interval of intervals) {
    if (!Number.isInteger(interval.maxParallel) || interval.maxParallel <= 0) continue;
    const key = interval.sourceName;
    const group = groups.get(key) ?? {sourceName: key, maxParallel: interval.maxParallel, intervals: []};
    group.intervals.push(interval);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function matrixEvidenceForJob(interval, group, readyAt) {
  const groupSegments = temporalSegments(group.intervals);
  const saturated = groupSegments.find((segment) =>
    segment.concurrency >= group.maxParallel &&
    timestamp(segment.endAt) > readyAt &&
    timestamp(segment.startAt) < interval.start,
  );
  if (!saturated) {
    return phase('matrix-throttle', interval.start === null ? null : iso(readyAt), interval.start === null ? null : iso(interval.start), {
      status: 'no-claim',
      classification: 'runner-queue-or-matrix-throttle-unseparated',
      maxParallel: group.maxParallel,
      observation: 'no interval with the declared matrix cap saturated before this job started',
    });
  }
  const start = Math.max(readyAt, timestamp(saturated.startAt));
  const end = Math.min(interval.start, timestamp(saturated.endAt));
  return phase('matrix-throttle', iso(start), iso(end), {
    classification: 'matrix-cap-saturated-upper-bound',
    maxParallel: group.maxParallel,
    observedConcurrency: saturated.concurrency,
    jobs: saturated.jobs,
    runnerNames: saturated.runnerNames,
    runnerContentionUnseparated: true,
  });
}

function artifactOwner(artifact, jobs) {
  const name = String(artifact?.name ?? '').toLowerCase();
  if (name.includes('prerequisite')) return jobs.find((job) => job.name === 'prerequisite-release')?.name ?? null;
  if (name.includes('smoke')) return jobs.find((job) => job.name === 'smoke-play')?.name ?? null;
  return null;
}

function artifactEvents(artifacts, run, jobs) {
  return (Array.isArray(artifacts) ? artifacts : []).map((artifact) => {
    const createdAt = firstDefined(artifact?.createdAt, artifact?.created_at);
    const ownerJobName = artifactOwner(artifact, jobs);
    const workflowRun = artifact?.workflowRun ?? artifact?.workflow_run ?? null;
    return {
      id: artifact?.id ?? null,
      name: artifact?.name ?? null,
      digest: artifact?.digest ?? null,
      createdAt,
      ownerJobName,
      attributable: ownerJobName !== null,
      workflowRunId: workflowRun?.id ?? run?.id ?? null,
      workflowRunAttempt: workflowRun?.run_attempt ?? run?.run_attempt ?? null,
    };
  }).filter((artifact) => timestamp(artifact.createdAt) !== null);
}

function artifactAttemptMatch(artifact, run) {
  const workflowRun = artifact?.workflowRun ?? artifact?.workflow_run ?? null;
  if (!workflowRun) return 'missing';
  if (workflowRun.id !== run?.id || (workflowRun.run_attempt !== undefined && workflowRun.run_attempt !== run?.run_attempt)) return 'mismatch';
  return 'match';
}

function firstFailure(jobs) {
  const failures = jobs.filter((job) => TERMINAL_FAILURES.has(String(job.conclusion ?? '').toLowerCase()));
  if (failures.length === 0) return {status: 'none', first: null, ambiguous: false};
  const ordered = failures
    .map((job) => ({job, completed: timestamp(job.completedAt)}))
    .filter(({completed}) => completed !== null)
    .sort((left, right) => left.completed - right.completed);
  if (ordered.length === 0) return {status: 'no-claim', first: null, ambiguous: false};
  const firstCompleted = ordered[0].completed;
  const tied = ordered.filter(({completed}) => completed === firstCompleted);
  return {
    status: tied.length === 1 ? 'observed' : 'ambiguous',
    first: tied.length === 1 ? {
      identity: tied[0].job.identity ?? {name: tied[0].job.name},
      name: tied[0].job.name,
      conclusion: tied[0].job.conclusion,
      completedAt: iso(firstCompleted),
    } : null,
    ambiguousJobs: tied.map(({job}) => job.name).sort(),
    ambiguous: tied.length > 1,
  };
}

function provenanceFor({run, sourceSha, workflow, topology, ruleset}) {
  return {
    sourceSha: sourceSha ?? run?.head_sha ?? null,
    runId: run?.id ?? null,
    runAttempt: run?.run_attempt ?? null,
    topologyId: topology?.topologyId ?? null,
    graphDigest: topology?.graphDigest ?? null,
    rosterKey: topology?.rosterKey ?? null,
    workflow: workflow ?? null,
    ruleset: ruleset ?? null,
  };
}

function validateJobBoundaries({run, jobs, artifacts, topology, provenance}) {
  const reasons = [];
  if (provenance.sourceSha && (run?.head_sha ?? run?.headSha) && provenance.sourceSha !== (run.head_sha ?? run.headSha)) reasons.push(noClaim(
    'source-generation-mismatch',
    provenance.sourceSha,
    run.head_sha ?? run.headSha,
    'Do not sign a capacity packet whose run head differs from the frozen workflow source.',
    provenance,
  ));
  const runStart = timestamp(firstDefined(run?.run_started_at, run?.runStartedAt));
  const runCreated = timestamp(firstDefined(run?.created_at, run?.createdAt));
  const runUpdated = timestamp(firstDefined(run?.updated_at, run?.updatedAt));
  if (runCreated === null || runStart === null || runUpdated === null) reasons.push(noClaim(
    'run-boundary-missing',
    'run created_at, run_started_at, and updated_at',
    {createdAt: run?.created_at ?? run?.createdAt ?? null, runStartedAt: run?.run_started_at ?? run?.runStartedAt ?? null, updatedAt: run?.updated_at ?? run?.updatedAt ?? null},
    'Collect the exact run boundary fields before deriving capacity intervals.',
    provenance,
  ));
  if (runCreated !== null && runStart !== null && runStart < runCreated) reasons.push(noClaim(
    'run-boundary-reversed',
    'run_started_at >= created_at',
    {createdAt: iso(runCreated), runStartedAt: iso(runStart)},
    'Discard the run packet when the workflow boundary is reversed.',
    provenance,
  ));
  const definitions = new Set(topology?.acceptedJobNames ?? []);
  for (const job of jobs) {
    const created = timestamp(job.createdAt);
    const started = timestamp(job.startedAt);
    const completed = timestamp(job.completedAt);
    if (!definitions.has(job.name)) reasons.push(noClaim('job-roster-mismatch', definitions, job.name, 'Use the admitted live matrix-expanded roster.', provenance));
    if (job.runId !== run?.id || job.runAttempt !== run?.run_attempt) reasons.push(noClaim(
      'job-attempt-identity-mismatch',
      {runId: run?.id ?? null, runAttempt: run?.run_attempt ?? null},
      {jobId: job.id ?? null, runId: job.runId ?? null, runAttempt: job.runAttempt ?? null},
      'Do not fold jobs from another workflow attempt into this timeline.',
      provenance,
    ));
    if (created === null || started === null || completed === null) reasons.push(noClaim(
      'job-timestamp-missing',
      'job created_at, started_at, and completed_at',
      {name: job.name, createdAt: job.createdAt, startedAt: job.startedAt, completedAt: job.completedAt},
      'Retain the job as no-claim until all three timestamp boundaries are present.',
      provenance,
    ));
    if (created !== null && started !== null && completed !== null && (started < created || completed < started)) reasons.push(noClaim(
      'job-timestamp-reversed',
      'created_at <= started_at <= completed_at',
      {name: job.name, createdAt: job.createdAt, startedAt: job.startedAt, completedAt: job.completedAt},
      'Do not clamp or repair a reversed GitHub job packet.',
      provenance,
    ));
    if (runStart !== null && started !== null && started < runStart) reasons.push(noClaim(
      'job-before-attempt-start',
      'job.started_at >= run.run_started_at for the selected attempt',
      {name: job.name, startedAt: job.startedAt, runStartedAt: firstDefined(run?.run_started_at, run?.runStartedAt)},
      'This packet is a rerun/history mix; preserve it as external evidence and do not claim a clean sample.',
      provenance,
    ));
    const runnerIssue = runnerIdentityIssue(job);
    if (runnerIssue) reasons.push(noClaim(
      runnerIssue,
      'runner id, runner name, and exactly one standard/heavy label for a non-skipped job',
      {name: job.name, runner: runnerProjection(job)},
      'Bind the real Actions runner identity; labels alone are not capacity proof.',
      provenance,
    ));
  }
  for (const artifact of artifacts) {
    const match = artifactAttemptMatch(artifact, run);
    if (match === 'missing') reasons.push(noClaim(
      'artifact-attempt-identity-missing',
      {runId: run?.id ?? null, runAttempt: run?.run_attempt ?? null},
      {artifactId: artifact?.id ?? null, artifactName: artifact?.name ?? null},
      'Do not attach an artifact-ready event without the workflow run identity from the artifact API.',
      provenance,
    ));
    if (match === 'mismatch') reasons.push(noClaim(
      'artifact-attempt-identity-mismatch',
      {runId: run?.id ?? null, runAttempt: run?.run_attempt ?? null},
      {artifactId: artifact?.id ?? null, artifactName: artifact?.name ?? null, workflowRun: artifact?.workflowRun ?? artifact?.workflow_run ?? null},
      'Do not fold an artifact from another run attempt into this capacity timeline.',
      provenance,
    ));
  }
  return {reasons, runCreated, runStart, runUpdated};
}

export function deriveCapacityTimeline({
  run,
  jobs: inputJobs,
  artifacts = [],
  topology,
  sourceSha,
  workflow = null,
  ruleset = null,
  sourceFiles = [],
} = {}) {
  const provenance = provenanceFor({run, sourceSha, workflow, topology, ruleset});
  const jobs = (Array.isArray(inputJobs) ? inputJobs : []).map((job) => {
    const definition = topology?.acceptedJobs?.find((candidate) => candidate.name === (job?.name ?? job?.jobName)) ?? null;
    return normalizedJob(job, definition, run);
  });
  const inputArtifacts = Array.isArray(artifacts) ? artifacts : [];
  const sameAttemptArtifacts = inputArtifacts.filter((artifact) => artifactAttemptMatch(artifact, run) === 'match');
  const boundary = validateJobBoundaries({run, jobs, artifacts: inputArtifacts, topology, provenance});
  const intervals = jobIntervals(jobs, topology);
  const groups = matrixGroups(intervals);
  const groupBySourceName = new Map(groups.map((group) => [group.sourceName, group]));
  const byName = new Map(jobs.map((job) => [job.name, job]));
  const artifactRecords = artifactEvents(sameAttemptArtifacts, run, jobs);
  const phasesByJob = jobs.map((job) => {
    const jobStart = timestamp(job.startedAt);
    const jobEnd = timestamp(job.completedAt);
    const jobCreated = timestamp(job.createdAt);
    const incoming = incomingEdges(topology, job.name);
    const dependencyTimes = incoming.map((edge) => timestamp(byName.get(edge.from)?.completedAt)).filter((value) => value !== null);
    const readyAt = dependencyTimes.length > 0
      ? Math.max(boundary.runStart ?? Number.NaN, ...dependencyTimes)
      : boundary.runStart;
    const steps = classifyStepPhases(job);
    const interval = intervals.find((candidate) => candidate.name === job.name);
    const phases = [
      phase('workflow-created', firstDefined(run?.created_at, run?.createdAt), job.createdAt, {
        basis: 'workflow run created_at to this job created_at',
        runCreatedAt: firstDefined(run?.created_at, run?.createdAt),
      }),
      phase('dependency-ready', readyAt === null ? null : iso(readyAt), job.createdAt, {
        dependencyJobs: incoming.map((edge) => edge.from),
        readyAt: readyAt === null ? null : iso(readyAt),
        basis: incoming.length > 0 ? 'max completed_at of admitted needs and run_started_at' : 'run_started_at for a root job',
      }),
      eventPhase('runner-assigned', job.startedAt, {
        runner: runnerProjection(job),
        observation: 'job.started_at is the first observed runner-bound boundary; GitHub exposes no separate assignment timestamp',
      }),
      steps.setup,
      steps.task,
      eventPhase('terminal', job.completedAt, {
        conclusion: job.conclusion ?? null,
        identity: {runId: job.runId ?? null, runAttempt: job.runAttempt ?? null, jobId: job.id ?? null, name: job.name},
      }),
    ];
    if (job.name === 'smoke-play') {
      phases.push(phase('aggregate', job.startedAt, job.completedAt, {
        role: 'required-aggregate',
        basis: 'stable smoke-play parent job active interval',
      }));
    }
    if (interval && interval.sourceName && groupBySourceName.has(interval.sourceName)) {
      const group = groupBySourceName.get(interval.sourceName);
      phases.splice(2, 0, matrixEvidenceForJob(interval, group, readyAt ?? Number.NaN));
    }
    const ownedArtifacts = artifactRecords.filter((artifact) => artifact.ownerJobName === job.name);
    for (const artifact of ownedArtifacts) {
      phases.push(eventPhase('artifact-ready', artifact.createdAt, {
        artifactId: artifact.id,
        artifactName: artifact.name,
        artifactDigest: artifact.digest,
        attributable: true,
        observation: 'artifact created_at joined to the owner by producer naming contract',
      }));
    }
    if (jobCreated !== null && jobStart !== null && readyAt !== null && jobCreated < readyAt) {
      phases.push({kind: 'dependency-ready', status: 'no-claim', noClaim: 'job-created-before-dependency-ready'});
    }
    if (jobStart === null || jobEnd === null) phases.push({kind: 'terminal', status: 'no-claim', noClaim: 'job-terminal-boundary-missing'});
    return {
      identity: {runId: job.runId ?? null, runAttempt: job.runAttempt ?? null, jobId: job.id ?? null, name: job.name},
      name: job.name,
      conclusion: job.conclusion ?? null,
      status: job.status ?? null,
      runner: runnerProjection(job),
      pool: runnerProjection(job).pool ?? job.definition?.runner?.pool ?? null,
      sourceName: job.definition?.sourceName ?? job.definition?.name ?? job.name,
      matrixValues: job.definition?.matrixValues ?? {},
      intervals: phases,
      steps: job.steps,
    };
  });
  const heavyIntervals = intervals.filter((interval) => interval.pool === 'heavy' && Number.isFinite(interval.start) && Number.isFinite(interval.end) && interval.end >= interval.start);
  const heavyOccupancy = temporalSegments(heavyIntervals);
  const maxHeavyConcurrency = heavyOccupancy.reduce((max, segment) => Math.max(max, segment.concurrency), 0);
  const firstFailureFact = firstFailure(jobs);
  const wallSeconds = seconds(boundary.runCreated, boundary.runUpdated);
  const activeSecondsSum = intervals.reduce((sum, interval) => sum + (seconds(interval.start, interval.end) ?? 0), 0);
  const heavyActiveSecondsSum = heavyIntervals.reduce((sum, interval) => sum + (seconds(interval.start, interval.end) ?? 0), 0);
  const payload = {
    schemaVersion: CAPACITY_SCHEMA_VERSION,
    baselineSchemaVersion: BASELINE_SCHEMA_VERSION,
    provenance,
    sourceFiles,
    run: {
      id: run?.id ?? null,
      attempt: run?.run_attempt ?? null,
      status: run?.status ?? null,
      conclusion: run?.conclusion ?? null,
      createdAt: firstDefined(run?.created_at, run?.createdAt),
      runStartedAt: firstDefined(run?.run_started_at, run?.runStartedAt),
      updatedAt: firstDefined(run?.updated_at, run?.updatedAt),
      headSha: run?.head_sha ?? run?.headSha ?? null,
    },
    phases: [...CAPACITY_PHASES],
    jobs: phasesByJob,
    occupancy: {
      scope: 'one workflow run attempt',
      heavy: heavyOccupancy,
      maxHeavyConcurrency,
      heavyJobCount: heavyIntervals.length,
      matrixGroups: groups.map((group) => ({
        sourceName: group.sourceName,
        maxParallel: group.maxParallel,
        occupancy: temporalSegments(group.intervals),
        jobNames: group.intervals.map((interval) => interval.name).sort(),
      })),
    },
    artifacts: artifactRecords,
    artifactReady: artifactRecords.map((artifact) => phase('artifact-ready', artifact.createdAt, artifact.createdAt, {
      artifactId: artifact.id,
      artifactName: artifact.name,
      artifactDigest: artifact.digest,
      ownerJobName: artifact.ownerJobName,
      attributable: artifact.attributable,
      observation: artifact.attributable ? 'owner joined by naming contract' : 'run-level artifact event; producer job not observable from artifact metadata',
    })),
    firstFailure: firstFailureFact,
    wallClock: {
      createdToTerminalSeconds: wallSeconds,
      activeSecondsSum,
      heavyActiveSecondsSum,
      note: 'Active durations are occupancy inputs only; they are not an SLO or speedup claim.',
    },
    noClaim: boundary.reasons,
  };
  const signature = digest(payload);
  return {
    ...payload,
    status: boundary.reasons.length === 0 ? 'admitted' : 'no-claim',
    admissible: boundary.reasons.length === 0,
    signature: {
      algorithm: 'sha256',
      digest: signature,
      covers: 'canonical payload before signature',
      signer: 'content-addressed collector; no private-key claim',
    },
  };
}

function argument(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? fallback : fallback;
}

function gitOutput(args) {
  return execFileSync('git', args, {encoding: 'utf8'}).trim();
}

function gitShow(commit, path) {
  return execFileSync('git', ['show', `${commit}:${path}`], {encoding: 'utf8'});
}

function ghJson(endpoint) {
  return JSON.parse(execFileSync('gh', ['api', endpoint], {encoding: 'utf8', maxBuffer: 128 * 1024 * 1024}));
}

function ghPages(endpoint) {
  return JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', endpoint], {encoding: 'utf8', maxBuffer: 256 * 1024 * 1024}));
}

function selectRuleset(repo, requestedId) {
  if (requestedId) return ghJson(`repos/${repo}/rulesets/${requestedId}`);
  const pages = ghPages(`repos/${repo}/rulesets?per_page=100`);
  const rulesets = pages.flatMap((page) => Array.isArray(page) ? page : []);
  const candidates = rulesets
    .filter((ruleset) => ruleset?.enforcement === 'active' && ruleset?.target === 'branch')
    .map((ruleset) => ruleset?.conditions?.ref_name ? ruleset : ghJson(`repos/${repo}/rulesets/${ruleset.id}`))
    .filter((ruleset) => (ruleset?.conditions?.ref_name?.include ?? []).some((value) => value === '~DEFAULT_BRANCH' || value === 'refs/heads/main'));
  if (candidates.length !== 1) throw new Error(`expected exactly one active main branch ruleset, found ${candidates.length}`);
  return ghJson(`repos/${repo}/rulesets/${candidates[0].id}`);
}

function writeJson(path, value) {
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function collectCapacityAdmission({
  run,
  jobsPages,
  artifactPages,
  graph,
  requiredContexts,
  workflowFile,
  workflowName,
  sourceSha,
  sourceFiles = [],
  ruleset,
} = {}) {
  const rawJobs = flattenPaginatedObjects(jobsPages, 'jobs');
  const observedJobNames = rawJobs
    .filter((job) => job?.conclusion !== 'skipped')
    .map((job) => job?.name)
    .filter((name) => typeof name === 'string' && name.length > 0);
  const topology = admitWorkflowTopology(graph, {
    requiredContexts,
    observedJobNames,
    expandMatrix: true,
    workflowFile,
  });
  const acceptedNames = new Set(topology.acceptedJobNames);
  const jobs = rawJobs.filter((job) => acceptedNames.has(job?.name));
  const artifacts = Array.isArray(artifactPages) && artifactPages.length > 0
    ? flattenPaginatedObjects(artifactPages, 'artifacts')
    : [];
  return deriveCapacityTimeline({
    run,
    jobs,
    artifacts,
    topology,
    sourceSha,
    sourceFiles,
    workflow: {file: workflowFile, name: workflowName},
    ruleset: ruleset ? {id: ruleset.id ?? null, digest: digest(ruleset)} : null,
  });
}

export function main(argv = process.argv.slice(2)) {
  const repo = argument(argv, '--repo', 'ForgeaX-Games/forgeax-editor');
  const workflow = argument(argv, '--workflow', 'ci.yml');
  const runId = Number(argument(argv, '--run-id'));
  const baselineCommit = argument(argv, '--baseline-commit', gitOutput(['rev-parse', 'HEAD']));
  const output = resolve(argument(argv, '--output', 'artifacts/ci-capacity-admission'));
  const rulesetId = argument(argv, '--ruleset-id');
  if (!Number.isInteger(runId) || runId <= 0) throw new Error('--run-id must be a positive integer');

  const run = ghJson(`repos/${repo}/actions/runs/${runId}`);
  if (run.head_sha !== baselineCommit) throw new Error(`source-generation-mismatch: run=${run.head_sha} baseline=${baselineCommit}`);
  const attempt = Number(argument(argv, '--attempt', run.run_attempt));
  if (!Number.isInteger(attempt) || attempt <= 0) throw new Error('--attempt must be a positive integer');
  const attemptRun = attempt === run.run_attempt
    ? run
    : ghJson(`repos/${repo}/actions/runs/${runId}/attempts/${attempt}`);
  if (attemptRun.head_sha !== baselineCommit) throw new Error(`source-generation-mismatch: attempt=${attemptRun.head_sha} baseline=${baselineCommit}`);
  const jobsEndpoint = `repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`;
  const artifactEndpoint = `repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`;
  const jobsPages = ghPages(jobsEndpoint);
  const artifactPages = ghPages(artifactEndpoint);
  const ruleset = selectRuleset(repo, rulesetId);
  const requiredContexts = extractRequiredContexts(ruleset);
  const workflowPaths = gitOutput(['ls-tree', '-r', '--name-only', baselineCommit, '--', '.github/workflows'])
    .split(/\r?\n/).filter((path) => path.endsWith('.yml') || path.endsWith('.yaml')).sort();
  const workflowSources = workflowPaths.map((path) => ({file: path, text: gitShow(baselineCommit, path)}));
  const graph = buildWorkflowGraph(workflowSources, requiredContexts);
  const workflowFile = `.github/workflows/${workflow}`;
  const workflowDefinition = graph.workflows.find((candidate) => candidate.file === workflowFile);
  if (!workflowDefinition) throw new Error(`workflow ${workflow} is not present at ${baselineCommit}`);
  const sourceFiles = workflowSources.map(({file, text}) => ({file, sha256: textDigest(text)}));
  const capacity = collectCapacityAdmission({
    run: {...attemptRun, run_attempt: attempt},
    jobsPages,
    artifactPages,
    graph,
    requiredContexts,
    workflowFile,
    workflowName: workflowDefinition.name,
    sourceSha: baselineCommit,
    sourceFiles,
    ruleset,
  });
  writeJson(join(output, 'run.json'), attemptRun);
  writeJson(join(output, 'jobs.json'), jobsPages);
  writeJson(join(output, 'artifacts.json'), artifactPages);
  writeJson(join(output, 'capacity-admission.json'), capacity);
  process.stdout.write(`${JSON.stringify({status: capacity.status, admissible: capacity.admissible, runId, attempt, sourceSha: baselineCommit, output, signature: capacity.signature, noClaim: capacity.noClaim}, null, 2)}\n`);
  if (!capacity.admissible) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[ci-capacity-admission] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
