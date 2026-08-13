// Reproducible editor CI control-plane and comparable-run contract.
//
// The workflow files, the live branch ruleset, and attempt-aware GitHub job
// packets are three different inputs. This module keeps their ownership
// explicit: workflow parsing builds the static graph, ruleset contexts bind
// the live required checks, and packet validation decides whether a terminal
// run belongs to one stable roster. It deliberately does not turn the result
// into an SLO.

import { parse as parseYaml } from 'yaml';
import { classifyRunnerSelector } from './check-runner-pool-labels.mjs';

export const BASELINE_SCHEMA_VERSION = 'forgeax-ci-baseline/v1';
export const MINIMUM_STABLE_ROSTER = 20;

const FAILURE_CONCLUSIONS = new Set([
  'action_required',
  'cancelled',
  'failure',
  'startup_failure',
  'timed_out',
]);

export class BaselineContractError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'BaselineContractError';
    this.code = code;
    this.details = details;
  }
}

function contractError(code, message, details = {}) {
  return new BaselineContractError(code, message, details);
}

function requireObject(value, code, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw contractError(code, message);
  }
  return value;
}

function nonEmptyString(value, code, message) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw contractError(code, message);
  }
  return value.trim();
}

function normalizeList(value, code, message) {
  if (value === undefined || value === null) return [];
  const values = Array.isArray(value) ? value : [value];
  if (!values.every((item) => typeof item === 'string' && item.trim().length > 0)) {
    throw contractError(code, message);
  }
  return values.map((item) => item.trim());
}

function runnerExpression(value) {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'string') return value;
  return String(value ?? '');
}

function matrixRunnerValues(job) {
  const runner = job?.strategy?.matrix?.runner;
  if (runner === undefined) return [];
  return Array.isArray(runner) ? runner.map((value) => String(value)) : [String(runner)];
}

function parseRunner(job, file, jobId) {
  if (job.uses !== undefined && job['runs-on'] === undefined) {
    return {
      kind: 'reusable-workflow',
      expression: String(job.uses),
      labels: [],
      pool: null,
    };
  }

  if (job['runs-on'] === undefined) {
    throw contractError(
      'job-runner-missing',
      `${file}: job ${jobId} must declare runs-on or use a reusable workflow`,
      { file, jobId },
    );
  }

  const expression = runnerExpression(job['runs-on']);
  const classification = classifyRunnerSelector(expression, matrixRunnerValues(job));
  if (classification.kind === 'error') {
    throw contractError('job-runner-invalid', `${file}: job ${jobId}: ${classification.message}`, {
      file,
      jobId,
      expression,
    });
  }
  return { expression, ...classification };
}

function normalizeWorkflowSources(sources) {
  const entries = Array.isArray(sources)
    ? sources
    : Object.entries(sources ?? {}).map(([file, text]) => ({ file, text }));
  if (entries.length === 0) throw contractError('workflow-source-empty', 'no workflow sources were supplied');
  return entries
    .map((entry) => ({
      file: nonEmptyString(entry?.file, 'workflow-source-invalid', 'workflow source file is missing'),
      text: nonEmptyString(entry?.text, 'workflow-source-invalid', 'workflow source text is missing'),
    }))
    .sort((left, right) => left.file.localeCompare(right.file));
}

function requiredContextName(value) {
  if (typeof value === 'string') return value;
  return value?.context ?? value?.name ?? null;
}

export function extractRequiredContexts(ruleset) {
  requireObject(ruleset, 'ruleset-invalid', 'live ruleset must be an object');
  const requiredRule = (ruleset.rules ?? []).find((rule) => rule?.type === 'required_status_checks');
  const records = requiredRule?.parameters?.required_status_checks;
  if (!Array.isArray(records) || records.length === 0) {
    throw contractError(
      'live-context-contract-empty',
      'live ruleset has no required_status_checks rule',
    );
  }
  return records.map((record) => ({
    context: nonEmptyString(
      requiredContextName(record),
      'live-context-invalid',
      'live required status check has no context',
    ),
    integrationId: Number.isInteger(record?.integration_id) ? record.integration_id : null,
  }));
}

function parseWorkflowSource(source) {
  let document;
  try {
    document = parseYaml(source.text);
  } catch (error) {
    throw contractError('workflow-yaml-invalid', `${source.file}: ${error.message}`, {
      file: source.file,
    });
  }
  requireObject(document, 'workflow-document-invalid', `${source.file}: workflow document is not an object`);
  const jobs = requireObject(document.jobs, 'workflow-jobs-missing', `${source.file}: jobs is missing`);
  const jobRecords = Object.entries(jobs).map(([id, value]) => {
    const job = requireObject(value, 'workflow-job-invalid', `${source.file}: job ${id} is not an object`);
    const timeout = job['timeout-minutes'];
    const timeoutMinutes = Number.isFinite(timeout) ? timeout : null;
    return {
      id,
      name: typeof job.name === 'string' && job.name.trim().length > 0 ? job.name.trim() : id,
      needs: normalizeList(
        job.needs,
        'job-needs-invalid',
        `${source.file}: job ${id} needs must be a string or string array`,
      ),
      runner: parseRunner(job, source.file, id),
      timeoutMinutes,
      condition: typeof job.if === 'string' ? job.if : null,
      uses: typeof job.uses === 'string' ? job.uses : null,
    };
  });

  return {
    file: source.file,
    name: typeof document.name === 'string' ? document.name : source.file,
    triggers: document.on ?? document.true ?? null,
    jobs: jobRecords,
  };
}

function attachLiveContexts(graph, requiredContexts) {
  return requiredContexts.map((required) => {
    const matches = graph.workflows.flatMap((workflow) =>
      workflow.jobs
        .filter((job) => job.id === required.context || job.name === required.context)
        .map((job) => ({ workflow: workflow.file, job })),
    );
    return {
      context: required.context,
      integrationId: required.integrationId ?? null,
      matches: matches.map(({ workflow, job }) => ({ workflow, jobId: job.id, jobName: job.name })),
      workflow: matches.length === 1 ? matches[0].workflow : null,
      jobId: matches.length === 1 ? matches[0].job.id : null,
      jobName: matches.length === 1 ? matches[0].job.name : null,
    };
  });
}

export function validateWorkflowGraph(graph, requiredContexts = graph?.requiredContexts ?? []) {
  requireObject(graph, 'workflow-graph-invalid', 'workflow graph must be an object');
  if (!Array.isArray(graph.workflows) || graph.workflows.length === 0) {
    throw contractError('workflow-graph-empty', 'workflow graph has no workflows');
  }
  const jobs = graph.workflows.flatMap((workflow) => workflow.jobs ?? []);
  if (jobs.length === 0) throw contractError('workflow-graph-empty', 'workflow graph has no jobs');

  const jobKeys = new Set();
  for (const job of jobs) {
    const key = `${job.workflow ?? ''}:${job.id ?? ''}`;
    if (jobKeys.has(key)) throw contractError('workflow-job-duplicate', `duplicate workflow job ${key}`);
    jobKeys.add(key);
    nonEmptyString(job.id, 'workflow-job-invalid', 'workflow job id is missing');
    nonEmptyString(job.name, 'workflow-job-invalid', `workflow job ${job.id} name is missing`);
    if (!Array.isArray(job.needs)) {
      throw contractError('job-needs-invalid', `workflow job ${job.id} needs is not an array`);
    }
    if (!job.runner || typeof job.runner.kind !== 'string') {
      throw contractError('job-runner-missing', `workflow job ${job.id} runner is missing`);
    }
    if (job.runner.kind !== 'reusable-workflow' && job.timeoutMinutes === null) {
      throw contractError('job-timeout-missing', `workflow job ${job.id} has no timeout-minutes`, {
        jobId: job.id,
      });
    }
    if (job.timeoutMinutes !== null && (!Number.isFinite(job.timeoutMinutes) || job.timeoutMinutes <= 0)) {
      throw contractError('job-timeout-invalid', `workflow job ${job.id} timeout is invalid`);
    }
  }

  const live = requiredContexts.map((value) => ({
    context: nonEmptyString(
      requiredContextName(value),
      'live-context-invalid',
      'live required context has no name',
    ),
    integrationId: Number.isInteger(value?.integrationId)
      ? value.integrationId
      : Number.isInteger(value?.integration_id)
        ? value.integration_id
        : null,
  }));
  if (live.length === 0) throw contractError('live-context-contract-empty', 'no live required contexts supplied');

  for (const context of live) {
    const record = (graph.requiredContexts ?? []).find((candidate) => candidate.context === context.context);
    if (!record) {
      throw contractError('live-context-missing', `workflow graph omitted live context ${context.context}`, {
        context: context.context,
      });
    }
    if (!record.jobId || !record.jobName) {
      throw contractError('live-context-job-missing', `live context ${context.context} has no workflow job`, {
        context: context.context,
        matches: record.matches ?? [],
      });
    }
    if (record.matches?.length !== 1) {
      throw contractError('live-context-job-ambiguous', `live context ${context.context} maps to multiple jobs`, {
        context: context.context,
        matches: record.matches,
      });
    }
  }
  return graph;
}

export function buildWorkflowGraph(sources, requiredContexts) {
  const workflows = normalizeWorkflowSources(sources).map(parseWorkflowSource);
  const graph = {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    workflows,
    needsEdges: workflows.flatMap((workflow) =>
      workflow.jobs.flatMap((job) =>
        job.needs.map((neededJob) => ({ workflow: workflow.file, from: neededJob, to: job.id })),
      ),
    ),
    requiredContexts: attachLiveContexts({ workflows }, requiredContexts),
  };
  return validateWorkflowGraph(graph, requiredContexts);
}

function dateSeconds(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed / 1000;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

export function flattenPaginatedObjects(pages, key) {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw contractError('pagination-missing', `paginated ${key} response has no pages`, { key });
  }
  const expected = pages[0]?.total_count;
  if (!Number.isInteger(expected) || expected < 0) {
    throw contractError('pagination-count-missing', `paginated ${key} response has no total_count`, { key });
  }
  const values = pages.flatMap((page) => (Array.isArray(page?.[key]) ? page[key] : []));
  if (values.length !== expected) {
    throw contractError(
      'pagination-incomplete',
      `paginated ${key} response contains ${values.length} items but declares ${expected}`,
      { key, actual: values.length, expected },
    );
  }
  return values;
}

export function flattenPaginatedArrayPages(pages, key) {
  if (!Array.isArray(pages) || pages.length === 0 || !pages.every((page) => Array.isArray(page))) {
    throw contractError('pagination-invalid', `paginated ${key} response is not an array of pages`, { key });
  }
  return pages.flat();
}

function labelsOf(job) {
  if (!Array.isArray(job?.labels)) return [];
  return job.labels
    .map((label) => (typeof label === 'string' ? label : label?.name))
    .filter((label) => typeof label === 'string' && label.length > 0)
    .sort();
}

function jobRosterEntry(job) {
  // GitHub's jobs API omits the capacity label from these historical packets;
  // the workflow graph is the runner/timeout SSOT. Roster identity therefore
  // stays on the live job names, not mutable runner host or label metadata.
  return { name: job.name };
}

function rosterKey(jobs) {
  return JSON.stringify(jobs.map(jobRosterEntry).sort((left, right) => left.name.localeCompare(right.name)));
}

function normalizedJob(job) {
  return {
    id: Number.isInteger(job?.id) ? job.id : null,
    name: typeof job?.name === 'string' ? job.name : null,
    status: typeof job?.status === 'string' ? job.status : null,
    conclusion: typeof job?.conclusion === 'string' ? job.conclusion : null,
    createdAt: typeof job?.created_at === 'string' ? job.created_at : null,
    startedAt: typeof job?.started_at === 'string' ? job.started_at : null,
    completedAt: typeof job?.completed_at === 'string' ? job.completed_at : null,
    runnerName: typeof job?.runner_name === 'string' ? job.runner_name : null,
    labels: labelsOf(job),
    runId: Number.isInteger(job?.run_id) ? job.run_id : null,
    runAttempt: Number.isInteger(job?.run_attempt) ? job.run_attempt : null,
  };
}

export function validateComparableSample(sample, {
  requiredContexts = [],
  expectedJobNames,
  requireTerminal = true,
} = {}) {
  requireObject(sample, 'sample-invalid', 'comparable sample must be an object');
  if (!Array.isArray(sample.jobs) || sample.jobs.length === 0) {
    throw contractError('zero-job-sample', 'comparable sample contains zero jobs');
  }
  const jobs = sample.jobs;
  if (jobs.some((job) => typeof job?.name !== 'string' || job.name.length === 0)) {
    throw contractError('job-name-missing', 'comparable sample contains a job without a live name');
  }
  if (expectedJobNames !== undefined) {
    const expected = [...expectedJobNames].sort();
    const actual = jobs.map((job) => job.name).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw contractError('roster-mismatch', 'comparable sample does not match the admitted workflow roster', {
        expected,
        actual,
        missing: expected.filter((name) => !actual.includes(name)),
        extra: actual.filter((name) => !expected.includes(name)),
      });
    }
  }
  if (requireTerminal && jobs.some((job) => job.status !== 'completed' || !job.conclusion)) {
    throw contractError('nonterminal-job-sample', 'comparable sample contains a non-terminal job');
  }

  for (const required of requiredContexts) {
    const context = requiredContextName(required);
    const jobName = required?.jobName ?? context;
    if (!jobs.some((job) => job.name === jobName || job.name === context)) {
      throw contractError('live-job-context-missing', `comparable sample omitted live job/context ${context}`, {
        context,
        expectedJobName: jobName,
        actualJobs: jobs.map((job) => job.name),
      });
    }
  }
  return sample;
}

export function assertStableRoster(samples, options = {}) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw contractError('stable-roster-empty', 'stable-roster validation received no samples');
  }
  samples.forEach((sample) => validateComparableSample(sample, options));
  const keys = new Set(samples.map((sample) => sample.rosterKey ?? rosterKey(sample.jobs)));
  if (keys.size !== 1) {
    throw contractError('mixed-roster', `comparable samples contain ${keys.size} job rosters`, {
      rosterKeys: [...keys],
    });
  }
  return [...keys][0];
}

export function normalizeAttemptJobPacket(run, pages, {
  requiredContexts = [],
  expectedJobNames,
} = {}) {
  requireObject(run, 'run-invalid', 'workflow run must be an object');
  if (!positiveInteger(run.id)) throw contractError('run-id-missing', 'workflow run id is missing');
  if (!positiveInteger(run.run_attempt)) {
    throw contractError('run-attempt-missing', `run ${run.id} has no positive run_attempt`);
  }
  const jobs = flattenPaginatedObjects(pages, 'jobs').map(normalizedJob);
  if (jobs.length === 0) throw contractError('zero-job-sample', `run ${run.id} attempt ${run.run_attempt} has zero jobs`);
  for (const job of jobs) {
    if (job.runId !== run.id) {
      throw contractError('job-run-mismatch', `run ${run.id} packet contains another run's job`, {
        jobId: job.id,
        jobRunId: job.runId,
      });
    }
    if (job.runAttempt !== run.run_attempt) {
      throw contractError('job-attempt-mismatch', `run ${run.id} packet contains a different attempt`, {
        jobId: job.id,
        jobAttempt: job.runAttempt,
        runAttempt: run.run_attempt,
      });
    }
  }
  const sample = {
    runId: run.id,
    runAttempt: run.run_attempt,
    run: {
      event: run.event ?? null,
      branch: run.head_branch ?? null,
      status: run.status ?? null,
      conclusion: run.conclusion ?? null,
      headSha: run.head_sha ?? null,
      createdAt: run.created_at ?? null,
      runStartedAt: run.run_started_at ?? null,
      updatedAt: run.updated_at ?? null,
      url: run.html_url ?? run.url ?? null,
    },
    jobs,
    rosterKey: rosterKey(jobs),
    jobCount: jobs.length,
  };
  return validateComparableSample(sample, { requiredContexts, expectedJobNames });
}

function differenceSeconds(later, earlier) {
  const laterSeconds = dateSeconds(later);
  const earlierSeconds = dateSeconds(earlier);
  if (laterSeconds === null || earlierSeconds === null) return null;
  return Math.max(0, laterSeconds - earlierSeconds);
}

function summarize(values) {
  const finite = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (finite.length === 0) return { count: 0, min: null, median: null, max: null, mean: null };
  const middle = Math.floor(finite.length / 2);
  const median = finite.length % 2 === 1 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2;
  return {
    count: finite.length,
    min: finite[0],
    median,
    max: finite.at(-1),
    mean: finite.reduce((sum, value) => sum + value, 0) / finite.length,
  };
}

export function deriveTimings(sample, { requiredContexts = [] } = {}) {
  validateComparableSample(sample, { requiredContexts });
  const requiredNames = new Set(requiredContexts.map((required) => required?.jobName ?? requiredContextName(required)));
  const requiredJobs = requiredNames.size === 0
    ? sample.jobs
    : sample.jobs.filter((job) => requiredNames.has(job.name) || requiredContexts.some((required) => job.name === requiredContextName(required)));
  const jobs = requiredJobs.length > 0 ? requiredJobs : sample.jobs;
  const jobTimings = jobs.map((job) => ({
    name: job.name,
    queueSeconds: differenceSeconds(job.startedAt, job.createdAt),
    activeSeconds: differenceSeconds(job.completedAt, job.startedAt),
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    conclusion: job.conclusion,
  }));
  const queueValues = jobTimings.map((job) => job.queueSeconds);
  const activeValues = jobTimings.map((job) => job.activeSeconds);
  const firstCreated = jobs.map((job) => dateSeconds(job.createdAt)).filter((value) => value !== null).sort((a, b) => a - b)[0];
  const firstStarted = jobs.map((job) => dateSeconds(job.startedAt)).filter((value) => value !== null).sort((a, b) => a - b)[0];
  const lastCompleted = jobs.map((job) => dateSeconds(job.completedAt)).filter((value) => value !== null).sort((a, b) => a - b).at(-1);
  const firstFailureJob = jobs
    .filter((job) => FAILURE_CONCLUSIONS.has(job.conclusion))
    .sort((left, right) => (dateSeconds(left.completedAt) ?? Number.POSITIVE_INFINITY) - (dateSeconds(right.completedAt) ?? Number.POSITIVE_INFINITY))[0] ?? null;
  const admissionSeconds = differenceSeconds(sample.run.runStartedAt, sample.run.createdAt);
  const activeSeconds = firstStarted === undefined || lastCompleted === undefined
    ? null
    : Math.max(0, lastCompleted - firstStarted);
  return {
    admissionSeconds,
    queueSeconds: summarize(queueValues).max,
    activeSeconds,
    firstFailureSeconds: firstFailureJob ? differenceSeconds(firstFailureJob.completedAt, sample.run.runStartedAt) : null,
    queue: {
      firstJobCreatedAt: firstCreated === undefined ? null : new Date(firstCreated * 1000).toISOString(),
      firstJobStartedAt: firstStarted === undefined ? null : new Date(firstStarted * 1000).toISOString(),
      byJob: jobTimings,
      summary: summarize(queueValues),
    },
    active: {
      firstRequiredJobStartedAt: firstStarted === undefined ? null : new Date(firstStarted * 1000).toISOString(),
      lastRequiredJobCompletedAt: lastCompleted === undefined ? null : new Date(lastCompleted * 1000).toISOString(),
      byJob: jobTimings.map((job) => ({ name: job.name, activeSeconds: job.activeSeconds })),
      summary: summarize(activeValues),
    },
    firstFailure: firstFailureJob
      ? {
          jobName: firstFailureJob.name,
          conclusion: firstFailureJob.conclusion,
          completedAt: firstFailureJob.completedAt,
          secondsFromRunCreated: differenceSeconds(firstFailureJob.completedAt, sample.run.createdAt),
          secondsFromAdmission: differenceSeconds(firstFailureJob.completedAt, sample.run.runStartedAt),
        }
      : null,
  };
}

export function comparableRunFilterReason(run) {
  if (!positiveInteger(run?.id)) return 'run-id-missing';
  if (!positiveInteger(run?.run_attempt)) return 'run-attempt-missing';
  if (run.status !== 'completed') return 'run-not-terminal';
  if (run.event !== 'push') return 'event-not-push';
  if (run.head_branch !== 'main') return 'branch-not-main';
  if (!['success', 'failure'].includes(run.conclusion)) return 'conclusion-not-comparable';
  return null;
}

export function stableRosterPopulation(samples, {
  requiredContexts = [],
  expectedJobNames,
  minimum = MINIMUM_STABLE_ROSTER,
} = {}) {
  const groups = new Map();
  const rejected = [];
  for (const sample of samples) {
    try {
      validateComparableSample(sample, { requiredContexts, expectedJobNames });
      const key = sample.rosterKey ?? rosterKey(sample.jobs);
      const group = groups.get(key) ?? [];
      group.push(sample);
      groups.set(key, group);
    } catch (error) {
      rejected.push({ runId: sample?.runId ?? null, code: error.code ?? 'sample-invalid', message: error.message });
    }
  }
  const rosterGroups = [...groups.entries()]
    .map(([rosterKeyValue, group]) => ({ rosterKey: rosterKeyValue, count: group.length, runIds: group.map((sample) => sample.runId) }))
    .sort((left, right) => right.count - left.count || left.rosterKey.localeCompare(right.rosterKey));
  const selected = rosterGroups[0] ?? null;
  const stableRosterCount = selected?.count ?? 0;
  const insufficiency = stableRosterCount < minimum
    ? `Only ${stableRosterCount} stable-roster terminal comparable runs were available after filtering and packet validation; at least ${minimum} are required for any SLO claim. No SLO claim is made.`
    : null;
  return {
    rosterGroups,
    selectedRosterKey: selected?.rosterKey ?? null,
    stableRosterCount,
    minimumRequired: minimum,
    sufficientForSloPopulation: stableRosterCount >= minimum,
    sloClaim: null,
    insufficiency,
    rejected,
  };
}
