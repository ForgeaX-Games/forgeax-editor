// Reproducible editor CI control-plane and comparable-run contract.
//
// The workflow files, the live branch ruleset, and attempt-aware GitHub job
// packets are three different inputs. This module keeps their ownership
// explicit: workflow parsing builds the static graph, ruleset contexts bind
// the live required checks, and packet validation decides whether a terminal
// run belongs to one stable roster. It deliberately does not turn the result
// into an SLO.

import { parse as parseYaml } from 'yaml';
import { createHash } from 'node:crypto';
import { classifyRunnerSelector } from './check-runner-pool-labels.mjs';

export const BASELINE_SCHEMA_VERSION = 'forgeax-ci-baseline/v2';
export const MINIMUM_STABLE_ROSTER = 20;

export const ATTEMPT_PROVENANCE_FIELDS = Object.freeze([
  'sourceSha',
  'runId',
  'runAttempt',
  'topologyId',
  'graphDigest',
  'rosterKey',
  'workflow',
]);

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
    this.expected = details.expected ?? null;
    this.observed = details.observed ?? null;
    this.hint = details.hint ?? `Inspect the structured evidence for ${code} and retry with one identity.`;
    this.affectedProvenance = details.affectedProvenance ?? null;
  }
}

function contractError(code, message, details = {}) {
  return new BaselineContractError(code, message, details);
}

export function toStructuredError(error) {
  return {
    code: error?.code ?? 'baseline-contract-error',
    expected: error?.expected ?? null,
    observed: error?.observed ?? null,
    hint: error?.hint ?? 'Inspect the structured evidence and retry with one identity.',
    affectedProvenance: error?.affectedProvenance ?? null,
  };
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

function provenanceWorkflow(value) {
  requireObject(value, 'attempt-provenance-missing', 'attempt provenance workflow identity is missing');
  return {
    file: nonEmptyString(value.file, 'attempt-provenance-missing', 'attempt provenance workflow file is missing'),
    name: nonEmptyString(value.name, 'attempt-provenance-missing', 'attempt provenance workflow name is missing'),
  };
}

export function validateAttemptProvenance(value) {
  requireObject(value, 'attempt-provenance-missing', 'attempt provenance envelope is missing');
  for (const field of ATTEMPT_PROVENANCE_FIELDS) {
    if (value[field] === undefined || value[field] === null) {
      throw contractError('attempt-provenance-missing', `attempt provenance field ${field} is missing`, {
        expected: ATTEMPT_PROVENANCE_FIELDS,
        observed: value,
        hint: `Provide ${field} from the same run attempt before deriving any baseline block.`,
        affectedProvenance: value,
      });
    }
  }
  const sourceSha = nonEmptyString(value.sourceSha, 'attempt-provenance-invalid', 'attempt provenance sourceSha is empty');
  const topologyId = nonEmptyString(value.topologyId, 'attempt-provenance-invalid', 'attempt provenance topologyId is empty');
  const graphDigest = nonEmptyString(value.graphDigest, 'attempt-provenance-invalid', 'attempt provenance graphDigest is empty');
  const rosterKey = nonEmptyString(value.rosterKey, 'attempt-provenance-invalid', 'attempt provenance rosterKey is empty');
  if (!positiveInteger(value.runId)) {
    throw contractError('attempt-provenance-invalid', 'attempt provenance runId must be positive', {
      expected: 'positive integer runId', observed: value.runId, hint: 'Read runId from the exact workflow run packet.', affectedProvenance: value,
    });
  }
  if (!positiveInteger(value.runAttempt)) {
    throw contractError('attempt-provenance-invalid', 'attempt provenance runAttempt must be positive', {
      expected: 'positive integer runAttempt', observed: value.runAttempt, hint: 'Read runAttempt from the exact workflow attempt packet.', affectedProvenance: value,
    });
  }
  return {
    sourceSha,
    runId: value.runId,
    runAttempt: value.runAttempt,
    topologyId,
    graphDigest,
    rosterKey,
    workflow: provenanceWorkflow(value.workflow),
  };
}

export function createAttemptProvenance(value) {
  return validateAttemptProvenance(value);
}

function provenanceField(provenance, field) {
  if (field === 'workflow') return JSON.stringify(provenance.workflow);
  return provenance[field];
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function graphDigest(graph) {
  return `sha256:${createHash('sha256').update(stableJson(graph)).digest('hex')}`;
}

function declaredGraphError(code, message, details) {
  return contractError(code, message, {
    ...details,
    hint: details.hint ?? 'Use one complete workflow declaration and re-read the immutable workflow source.',
  });
}

function provenanceMismatchCode(field) {
  if (field === 'runId' || field === 'runAttempt') return 'mixed-attempt';
  if (field === 'sourceSha') return 'mixed-source-sha';
  if (field === 'rosterKey') return 'mixed-roster';
  if (field === 'topologyId' || field === 'graphDigest') return 'mixed-topology';
  return 'mixed-workflow';
}

function throwMissingNeeds(workflow, job, neededJob, jobs) {
  throw declaredGraphError('workflow-needs-missing', `${workflow.file}: ${job.id} needs missing job ${neededJob}`, {
    expected: [...jobs.keys()],
    observed: { workflow: workflow.file, job: job.id, needs: neededJob },
    affectedProvenance: { workflow: workflow.file },
  });
}

function throwWorkflowCycle(workflow, path, jobId) {
  throw declaredGraphError('workflow-cycle', `${workflow.file}: workflow needs cycle detected`, {
    expected: 'acyclic needs graph',
    observed: [...path, jobId],
    affectedProvenance: { workflow: workflow.file },
  });
}

function validateDeclaredNeeds(graph) {
  for (const workflow of graph.workflows) {
    const jobs = new Map(workflow.jobs.map((job) => [job.id, job]));
    for (const job of workflow.jobs) {
      for (const neededJob of job.needs) {
        if (!jobs.has(neededJob)) throwMissingNeeds(workflow, job, neededJob, jobs);
      }
    }

    const visiting = new Set();
    const visited = new Set();
    const visit = (jobId, path) => {
      if (visiting.has(jobId)) throwWorkflowCycle(workflow, path, jobId);
      if (visited.has(jobId)) return;
      visiting.add(jobId);
      const job = jobs.get(jobId);
      for (const neededJob of job.needs) visit(neededJob, [...path, jobId]);
      visiting.delete(jobId);
      visited.add(jobId);
    };
    for (const job of workflow.jobs) visit(job.id, []);
  }
}

function conditionIsAdmitted(condition) {
  if (condition === null || condition === undefined) return true;
  const normalized = String(condition).trim().replace(/^\$?\{\{\s*/, '').replace(/\s*\}\}$/, '').trim();
  if (/^false$/i.test(normalized) || /\bfalse\b/i.test(normalized)) return false;
  // An always() wrapper makes the job part of the declared topology even when
  // the event/profile expression narrows a particular runtime attempt. The
  // observed packet still has to contain the complete accepted roster.
  return /\balways\s*\(\s*\)/.test(normalized);
}

function requiredContextProjection(requiredContexts) {
  const records = requiredContexts.map((required) => ({
    context: requiredContextName(required),
    jobId: required.jobId ?? null,
    jobName: required.jobName ?? requiredContextName(required),
    workflow: required.workflow ?? null,
  }));
  return {
    status: records.length > 0 ? 'observed' : 'no-claim',
    contexts: records.map((record) => record.context),
    records,
    source: 'live-ruleset',
  };
}

function throwUnadmittedDependency(job, neededJob, acceptedNames) {
  throw declaredGraphError('topology-not-admitted', `accepted job ${job.name} depends on an unadmitted job`, {
    expected: acceptedNames,
    observed: { job: job.name, needs: neededJob },
    affectedProvenance: { acceptedJobNames: acceptedNames },
  });
}

function matrixJobVariants(job, expandMatrix) {
  if (!expandMatrix || !job?.strategy?.matrix) return [{name: job.name, matrixValues: {}}];
  const entries = Object.entries(job.strategy.matrix)
    .filter(([, values]) => Array.isArray(values) && values.length > 0);
  if (entries.length === 0) return [{name: job.name, matrixValues: {}}];
  let variants = [{matrixValues: {}}];
  for (const [key, values] of entries) {
    variants = variants.flatMap((variant) => values.map((value) => ({
      matrixValues: {...variant.matrixValues, [key]: value},
    })));
  }
  return variants.map((variant) => ({
    ...variant,
    name: job.name.replace(/\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}/g, (match, key) =>
      Object.hasOwn(variant.matrixValues, key) ? String(variant.matrixValues[key]) : match),
  }));
}

export function assertSameAttemptProvenance(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw contractError('attempt-provenance-missing', 'no attempt provenance values were supplied', {
      expected: 'at least one complete attempt provenance envelope',
      observed: values,
      hint: 'Attach the exact attempt envelope before deriving a block.',
      affectedProvenance: null,
    });
  }
  const normalized = values.map((value) => validateAttemptProvenance(value?.attemptProvenance ?? value));
  const first = normalized[0];
  for (const candidate of normalized.slice(1)) {
    for (const field of ATTEMPT_PROVENANCE_FIELDS) {
      if (provenanceField(first, field) !== provenanceField(candidate, field)) {
        const code = provenanceMismatchCode(field);
        throw contractError(code, `derived blocks do not share ${field}`, {
          expected: first,
          observed: candidate,
          hint: 'Discard the mixed inputs and re-derive every block from one exact run attempt and admitted topology.',
          affectedProvenance: { expected: first, observed: candidate },
        });
      }
    }
  }
  return first;
}

function normalizeList(value, code, message) {
  if (value === undefined || value === null) return [];
  const values = Array.isArray(value) ? value : [value];
  if (!values.every((item) => typeof item === 'string' && item.trim().length > 0)) {
    throw contractError(code, message);
  }
  return values.map((item) => item.trim());
}

function normalizePermissions(value, file, scope) {
  if (value === undefined) return null;
  if (typeof value === 'string') {
    if (!['read-all', 'write-all', 'none'].includes(value)) {
      throw contractError('workflow-permissions-invalid', `${file}: ${scope} permissions must use a supported aggregate value`, {file, scope, value});
    }
    return value;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw contractError('workflow-permissions-invalid', `${file}: ${scope} permissions must be an object or aggregate value`, {file, scope});
  }
  const permissions = {};
  for (const key of Object.keys(value).sort()) {
    const permission = value[key];
    if (!['read', 'write', 'none'].includes(permission)) {
      throw contractError('workflow-permissions-invalid', `${file}: ${scope} permission ${key} must be read, write, or none`, {file, scope, key, permission});
    }
    permissions[key] = permission;
  }
  return permissions;
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

function normalizeMatrixValue(value) {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  return [];
}

function normalizeStrategy(strategy) {
  if (!strategy || typeof strategy !== 'object' || Array.isArray(strategy)) return null;
  const matrix = strategy.matrix && typeof strategy.matrix === 'object' && !Array.isArray(strategy.matrix)
    ? Object.fromEntries(
      Object.entries(strategy.matrix)
        .filter(([key]) => key !== 'include' && key !== 'exclude')
        .map(([key, value]) => [key, normalizeMatrixValue(value)])
        .filter(([, values]) => values.length > 0),
    )
    : {};
  const maxParallel = Number.isInteger(strategy['max-parallel']) && strategy['max-parallel'] > 0
    ? strategy['max-parallel']
    : null;
  return {
    maxParallel,
    matrix,
  };
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
  const workflowPermissions = normalizePermissions(document.permissions, source.file, 'workflow');
  const jobRecords = Object.entries(jobs).map(([id, value]) => {
    const job = requireObject(value, 'workflow-job-invalid', `${source.file}: job ${id} is not an object`);
    const timeout = job['timeout-minutes'];
    const timeoutMinutes = Number.isFinite(timeout) ? timeout : null;
    const jobPermissions = normalizePermissions(job.permissions, source.file, `job ${id}`);
    return {
      id,
      name: typeof job.name === 'string' && job.name.trim().length > 0 ? job.name.trim() : id,
      needs: normalizeList(
        job.needs,
        'job-needs-invalid',
        `${source.file}: job ${id} needs must be a string or string array`,
      ),
      runner: parseRunner(job, source.file, id),
      strategy: normalizeStrategy(job.strategy),
      timeoutMinutes,
      condition: typeof job.if === 'string' ? job.if : null,
      uses: typeof job.uses === 'string' ? job.uses : null,
      permissions: jobPermissions ?? workflowPermissions,
      permissionsSource: jobPermissions === null ? 'workflow' : 'job',
    };
  });

  return {
    file: source.file,
    name: typeof document.name === 'string' ? document.name : source.file,
    triggers: document.on ?? document.true ?? null,
    permissions: workflowPermissions,
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

export function validateWorkflowGraph(graph, requiredContexts = graph?.requiredContexts ?? [], {requireLiveContexts = true, requireRuntimeFields = true} = {}) {
  requireObject(graph, 'workflow-graph-invalid', 'workflow graph must be an object');
  if (!Array.isArray(graph.workflows) || graph.workflows.length === 0) {
    throw contractError('workflow-graph-empty', 'workflow graph has no workflows');
  }
  const jobs = graph.workflows.flatMap((workflow) => workflow.jobs ?? []);
  if (jobs.length === 0) throw contractError('workflow-graph-empty', 'workflow graph has no jobs');
  validateDeclaredNeeds(graph);

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
    if (requireRuntimeFields && (!job.runner || typeof job.runner.kind !== 'string')) {
      throw contractError('job-runner-missing', `workflow job ${job.id} runner is missing`);
    }
    if (requireRuntimeFields && job.runner.kind !== 'reusable-workflow' && job.timeoutMinutes === null) {
      throw contractError('job-timeout-missing', `workflow job ${job.id} has no timeout-minutes`, {
        jobId: job.id,
      });
    }
    if (requireRuntimeFields && job.timeoutMinutes !== null && (!Number.isFinite(job.timeoutMinutes) || job.timeoutMinutes <= 0)) {
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
  if (requireLiveContexts && live.length === 0) throw contractError('live-context-contract-empty', 'no live required contexts supplied');

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

export function admitWorkflowTopology(graph, {
  requiredContexts = graph?.requiredContexts ?? [],
  observedJobNames,
  attemptProvenance,
  expandMatrix = false,
  workflowFile,
} = {}) {
  const graphForValidation = graph.requiredContexts?.length > 0
    ? graph
    : {...graph, requiredContexts};
  validateWorkflowGraph(graphForValidation, requiredContexts, {requireLiveContexts: false, requireRuntimeFields: false});
  const selectedWorkflows = workflowFile === undefined
    ? graph.workflows
    : graph.workflows.filter((workflow) => workflow.file === workflowFile);
  if (selectedWorkflows.length !== 1) {
    throw declaredGraphError('workflow-not-admitted', 'topology admission must select exactly one workflow source', {
      expected: workflowFile ?? 'one workflow source',
      observed: graph.workflows.map((workflow) => workflow.file),
      affectedProvenance: {workflowFile},
    });
  }
  const workflowJobs = selectedWorkflows.flatMap((workflow) => workflow.jobs.map((job) => ({
    ...job,
    workflow: workflow.file,
  })));
  const inventory = workflowJobs.filter((job) => !conditionIsAdmitted(job.condition));
  const admittedCandidates = workflowJobs.filter((job) => conditionIsAdmitted(job.condition));
  const candidateVariants = admittedCandidates.flatMap((job) => matrixJobVariants(job, expandMatrix).map((variant) => ({
    ...variant,
    job,
  })));
  const byName = new Map(candidateVariants.map((variant) => [variant.name, variant]));
  const acceptedNames = observedJobNames === undefined
    ? candidateVariants.map((variant) => variant.name)
    : [...observedJobNames];
  const acceptedSet = new Set(acceptedNames);
  if (acceptedSet.size !== acceptedNames.length || acceptedNames.some((name) => !byName.has(name))) {
    throw declaredGraphError('topology-not-admitted', 'observed topology contains unknown or duplicate jobs', {
      expected: candidateVariants.map((variant) => variant.name),
      observed: acceptedNames,
      affectedProvenance: { observedJobNames: acceptedNames },
    });
  }
  if (observedJobNames !== undefined) {
    const expected = candidateVariants.map((variant) => variant.name).sort();
    const observed = [...acceptedNames].sort();
    if (JSON.stringify(expected) !== JSON.stringify(observed)) {
      throw declaredGraphError('topology-not-admitted', 'observed topology does not contain the complete accepted roster', {
        expected,
        observed,
        affectedProvenance: {expectedJobNames: expected, observedJobNames: observed},
      });
    }
  }
  const unadmittedConditional = acceptedNames.find((name) => !conditionIsAdmitted(byName.get(name).job.condition));
  if (unadmittedConditional) {
    throw declaredGraphError('topology-not-admitted', `conditional job ${unadmittedConditional} is not admitted`, {
      expected: candidateVariants.map((variant) => variant.name),
      observed: acceptedNames,
      affectedProvenance: { observedJobNames: acceptedNames },
    });
  }
  const acceptedJobs = acceptedNames.map((name) => {
    const variant = byName.get(name);
    return {
      ...variant.job,
      name,
      sourceName: variant.job.name,
      matrixValues: variant.matrixValues,
    };
  });
  const needsEdges = [];
  for (const job of acceptedJobs) {
    for (const neededJob of job.needs) {
      const targets = acceptedJobs.filter((candidate) => candidate.workflow === job.workflow && candidate.id === neededJob);
      if (targets.length === 0) throwUnadmittedDependency(job, neededJob, acceptedNames);
      for (const target of targets) needsEdges.push({ workflow: job.workflow, from: target.name, to: job.name });
    }
  }
  const rosterKeyValue = rosterKey(acceptedJobs.map((job) => ({ name: job.name })));
  const digest = graphDigest({
    workflows: graph.workflows,
    acceptedJobNames: [...acceptedNames].sort(),
    needsEdges: [...needsEdges].sort((left, right) =>
      `${left.workflow}\u0000${left.from}\u0000${left.to}`.localeCompare(`${right.workflow}\u0000${right.from}\u0000${right.to}`)),
  });
  const provenance = attemptProvenance === undefined
    ? null
    : createAttemptProvenance(attemptProvenance);
  return {
    status: 'accepted',
    topologyId: `topology-${digest.slice(-16)}`,
    graphDigest: digest,
    rosterKey: rosterKeyValue,
    acceptedJobNames: acceptedNames,
    acceptedJobs,
    needsEdges,
    inventory,
    requiredContexts: requiredContextProjection(requiredContexts),
    ...(provenance ? {attemptProvenance: provenance} : {}),
  };
}

function timingRecord(jobTimings, name) {
  if (Array.isArray(jobTimings)) return jobTimings.find((timing) => timing?.name === name) ?? null;
  return jobTimings?.[name] ?? null;
}

function knownDuration(timing) {
  if (Object.hasOwn(timing ?? {}, 'activeSeconds')) {
    return Number.isFinite(timing.activeSeconds) && timing.activeSeconds >= 0
      ? timing.activeSeconds
      : null;
  }
  if (Number.isFinite(timing?.activeSeconds) && timing.activeSeconds >= 0) return timing.activeSeconds;
  const started = dateSeconds(timing?.startedAt);
  const completed = dateSeconds(timing?.completedAt);
  if (started === null || completed === null || completed < started) return null;
  return completed - started;
}

function noCriticalPathClaim(topology, expected, observed, hint, code = 'critical-path-timing-missing') {
  const error = contractError(code, 'critical path timing or topology is incomplete or invalid', {
    expected,
    observed,
    hint,
    affectedProvenance: topology.attemptProvenance ?? null,
  });
  return {
    status: 'no-claim',
    members: [],
    edges: [],
    timing: [],
    totalSeconds: null,
    requiredContexts: topology.requiredContexts,
    noClaim: toStructuredError(error),
  };
}

function topologicalNames(topology) {
  const names = topology.acceptedJobNames;
  const incoming = new Map(names.map((name) => [name, 0]));
  const outgoing = new Map(names.map((name) => [name, []]));
  for (const edge of topology.needsEdges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }
  const queue = names.filter((name) => incoming.get(name) === 0);
  const ordered = [];
  while (queue.length > 0) {
    const name = queue.shift();
    ordered.push(name);
    for (const next of outgoing.get(name) ?? []) {
      incoming.set(next, incoming.get(next) - 1);
      if (incoming.get(next) === 0) queue.push(next);
    }
  }
  return ordered;
}

export function deriveCriticalPath(topology, {jobTimings = {}} = {}) {
  if (!topology || topology.status !== 'accepted') {
    return noCriticalPathClaim(
      topology ?? {},
      'an accepted workflow topology',
      topology?.status ?? 'missing',
      'Admit one complete workflow topology before deriving a critical path.',
      'topology-not-admitted',
    );
  }
  const names = topology?.acceptedJobNames ?? [];
  if (names.length === 0) {
    return noCriticalPathClaim(
      topology,
      'at least one accepted topology member',
      names,
      'Collect a non-empty accepted roster before deriving a critical path.',
      'critical-path-topology-empty',
    );
  }
  const nameSet = new Set(names);
  if (!Array.isArray(topology.needsEdges) || topology.needsEdges.some((edge) => !nameSet.has(edge?.from) || !nameSet.has(edge?.to))) {
    return noCriticalPathClaim(
      topology,
      'needs edges whose endpoints are accepted topology members',
      topology.needsEdges ?? null,
      'Recollect the complete accepted workflow graph before deriving a path.',
      'critical-path-topology-invalid',
    );
  }
  const durations = new Map(names.map((name) => [name, knownDuration(timingRecord(jobTimings, name))]));
  const missing = names.filter((name) => durations.get(name) === null);
  if (missing.length > 0) {
    return noCriticalPathClaim(
      topology,
      `timing for every accepted path member: ${names.join(', ')}`,
      {missing, observed: jobTimings},
      'Collect started_at and completed_at for every job in the accepted topology and retry the same attempt.',
    );
  }

  const scores = new Map();
  const orderedNames = topologicalNames(topology);
  if (orderedNames.length !== names.length) {
    return noCriticalPathClaim(
      topology,
      'acyclic accepted workflow graph',
      topology.needsEdges,
      'Repair the workflow needs graph and recollect the attempt packet.',
      'workflow-cycle',
    );
  }
  for (const name of orderedNames) {
    const predecessors = topology.needsEdges.filter((edge) => edge.to === name);
    const bestPredecessor = predecessors
      .map((edge) => scores.get(edge.from))
      .filter(Boolean)
      .sort((left, right) => right.totalSeconds - left.totalSeconds)[0] ?? {totalSeconds: 0, members: [], edges: []};
    scores.set(name, {
      totalSeconds: bestPredecessor.totalSeconds + durations.get(name),
      members: [...bestPredecessor.members, name],
      edges: [...bestPredecessor.edges, ...predecessors.filter((edge) => edge.from === bestPredecessor.members.at(-1))],
    });
  }
  const best = [...scores.values()].sort((left, right) => right.totalSeconds - left.totalSeconds)[0];
  if (!best || !Number.isFinite(best.totalSeconds) || best.totalSeconds < 0 || best.members.length === 0) {
    return noCriticalPathClaim(
      topology,
      'a finite nonnegative critical-path total with members',
      best ?? null,
      'Collect complete nonnegative member timing for the accepted topology.',
      'critical-path-timing-invalid',
    );
  }
  const members = best.members;
  const selectedEdges = topology.needsEdges.filter((edge) => members.includes(edge.from) && members.includes(edge.to));
  return {
    status: 'observed',
    members,
    edges: selectedEdges,
    timing: members.map((name) => ({name, activeSeconds: durations.get(name)})),
    totalSeconds: best?.totalSeconds ?? 0,
    requiredContexts: topology.requiredContexts,
    ...(topology.attemptProvenance ? {attemptProvenance: topology.attemptProvenance} : {}),
  };
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

function rosterKeyMatches(left, right, jobs = []) {
  if (left === right) return true;
  const names = jobs.map((job) => job?.name).filter((name) => typeof name === 'string').sort();
  const shorthand = `[${names.join(',')}]`;
  return (left === shorthand && right === rosterKey(jobs)) || (right === shorthand && left === rosterKey(jobs));
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
    runnerId: Number.isInteger(job?.runner_id) ? job.runner_id : null,
    runnerName: typeof job?.runner_name === 'string' ? job.runner_name : null,
    runnerGroupId: Number.isInteger(job?.runner_group_id) ? job.runner_group_id : null,
    labels: labelsOf(job),
    runId: Number.isInteger(job?.run_id) ? job.run_id : null,
    runAttempt: Number.isInteger(job?.run_attempt) ? job.run_attempt : null,
    steps: Array.isArray(job?.steps)
      ? job.steps.map((step) => ({
          name: typeof step?.name === 'string' ? step.name : null,
          status: typeof step?.status === 'string' ? step.status : null,
          conclusion: typeof step?.conclusion === 'string' ? step.conclusion : null,
          number: Number.isInteger(step?.number) ? step.number : null,
          startedAt: typeof step?.started_at === 'string' ? step.started_at : null,
          completedAt: typeof step?.completed_at === 'string' ? step.completed_at : null,
        }))
      : [],
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

function normalizePacketSource(packet) {
  if (!Array.isArray(packet.workflowFiles) || packet.workflowFiles.length === 0) {
    throw contractError('source-provenance-missing', 'attempt packet has no workflow source digest', {
      expected: 'at least one workflow file with sha256',
      observed: packet.workflowFiles ?? null,
    });
  }
  const workflowFiles = packet.workflowFiles.map((file) => ({
    file: nonEmptyString(file?.file, 'source-provenance-missing', 'workflow source file is missing'),
    sha256: nonEmptyString(file?.sha256, 'source-provenance-missing', 'workflow source digest is missing'),
  }));
  if (!packet.ruleset || !positiveInteger(packet.ruleset.id) || typeof packet.ruleset.sha256 !== 'string' || packet.ruleset.sha256.length === 0) {
    throw contractError('ruleset-provenance-missing', 'attempt packet has no complete ruleset digest', {
      expected: 'ruleset id and sha256',
      observed: packet.ruleset ?? null,
    });
  }
  return {
    sourceSha: nonEmptyString(packet.sourceSha, 'source-provenance-missing', 'attempt sourceSha is missing'),
    workflowFiles,
    ruleset: {
      id: packet.ruleset.id,
      sha256: packet.ruleset.sha256,
    },
  };
}

function normalizeRunnerRoster(jobs) {
  const roster = jobs.map((job) => {
    if (!job.runnerName || job.labels.length === 0) {
      throw contractError('runner-identity-missing', `job ${job.name} has no runner identity`, {
        expected: 'runner name and at least one runner label',
        observed: {job: job.name, runnerName: job.runnerName, labels: job.labels},
      });
    }
    return {name: job.runnerName, labels: job.labels};
  });
  return roster.sort((left, right) => left.name.localeCompare(right.name));
}

function normalizePacketCache(cache) {
  if (cache === null || cache === undefined) return {status: 'unknown'};
  const status = cache.status;
  if (!['hit', 'miss', 'unknown'].includes(status)) {
    throw contractError('cache-observation-invalid', 'cache status must be hit, miss, or unknown', {
      expected: ['hit', 'miss', 'unknown'],
      observed: status,
    });
  }
  return {
    status,
    ...(typeof cache.key === 'string' ? {key: cache.key} : {}),
    ...(typeof cache.observationState === 'string' ? {observationState: cache.observationState} : {}),
    ...(typeof cache.endpoint === 'string' ? {endpoint: cache.endpoint} : {}),
    ...(cache.error && typeof cache.error === 'object' ? {error: structuredClone(cache.error)} : {}),
  };
}

function normalizePacketArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) return [];
  return artifacts.map((artifact) => ({
    id: positiveInteger(artifact?.id) ? artifact.id : null,
    name: typeof artifact?.name === 'string' ? artifact.name : null,
    digest: typeof artifact?.digest === 'string' ? artifact.digest : null,
    sizeInBytes: Number.isInteger(artifact?.size_in_bytes) && artifact.size_in_bytes >= 0
      ? artifact.size_in_bytes
      : null,
    expandedInputBytes: Number.isInteger(artifact?.expanded_input_bytes) && artifact.expanded_input_bytes >= 0
      ? artifact.expanded_input_bytes
      : null,
    expandedOutputBytes: Number.isInteger(artifact?.expanded_output_bytes) && artifact.expanded_output_bytes >= 0
      ? artifact.expanded_output_bytes
      : null,
  }));
}

export function normalizeAttemptPacket(packet, {
  requiredContexts = [],
  expectedJobNames,
  attemptProvenance,
  acceptedTopology,
  expectedWorkflow,
  expectedSourceSha,
  expectedRuleset,
} = {}) {
  requireObject(packet, 'packet-invalid', 'attempt packet must be an object');
  const source = normalizePacketSource(packet);
  if (expectedSourceSha !== undefined && source.sourceSha !== expectedSourceSha) {
    throw contractError('packet-source-mismatch', 'attempt packet source does not match the accepted workflow source', {
      expected: expectedSourceSha,
      observed: source.sourceSha,
      affectedProvenance: {sourceSha: source.sourceSha},
    });
  }
  if (expectedRuleset && (source.ruleset.id !== expectedRuleset.id || source.ruleset.sha256 !== expectedRuleset.sha256)) {
    throw contractError('packet-ruleset-mismatch', 'attempt packet ruleset does not match the accepted ruleset snapshot', {
      expected: expectedRuleset,
      observed: source.ruleset,
      affectedProvenance: {ruleset: source.ruleset},
    });
  }
  const run = requireObject(packet.run, 'run-invalid', 'attempt packet run is missing');
  if (source.sourceSha !== run.head_sha) {
    throw contractError('source-run-mismatch', 'attempt sourceSha does not match run head_sha', {
      expected: run.head_sha,
      observed: source.sourceSha,
    });
  }
  const sample = normalizeAttemptJobPacket(run, packet.jobsPages, {requiredContexts, expectedJobNames});
  const provenance = createAttemptProvenance(attemptProvenance ?? packet.attemptProvenance);
  if (provenance.runId !== run.id || provenance.runAttempt !== run.run_attempt || provenance.sourceSha !== source.sourceSha) {
    throw contractError('packet-provenance-mismatch', 'attempt packet fields do not match its provenance envelope', {
      expected: {runId: run.id, runAttempt: run.run_attempt, sourceSha: source.sourceSha},
      observed: provenance,
      affectedProvenance: provenance,
    });
  }
  const jobs = sample.jobs;
  if (!rosterKeyMatches(provenance.rosterKey, sample.rosterKey, jobs)) {
    throw contractError('packet-roster-mismatch', 'attempt packet roster does not match its provenance envelope', {
      expected: sample.rosterKey,
      observed: provenance.rosterKey,
      affectedProvenance: provenance,
    });
  }
  if (acceptedTopology) {
    const expectedTopology = {
      topologyId: acceptedTopology.topologyId,
      graphDigest: acceptedTopology.graphDigest,
      rosterKey: acceptedTopology.rosterKey,
    };
    if (provenance.topologyId !== expectedTopology.topologyId || provenance.graphDigest !== expectedTopology.graphDigest || !rosterKeyMatches(provenance.rosterKey, expectedTopology.rosterKey, jobs)) {
      throw contractError('packet-topology-mismatch', 'attempt packet topology does not match the accepted workflow topology', {
        expected: expectedTopology,
        observed: {topologyId: provenance.topologyId, graphDigest: provenance.graphDigest, rosterKey: provenance.rosterKey},
        affectedProvenance: provenance,
      });
    }
  }
  if (expectedWorkflow && stableJson(provenance.workflow) !== stableJson(expectedWorkflow)) {
    throw contractError('packet-workflow-mismatch', 'attempt packet workflow does not match the accepted workflow source', {
      expected: expectedWorkflow,
      observed: provenance.workflow,
      affectedProvenance: provenance,
    });
  }
  const rawPages = packet.rawPages ?? {};
  return {
    ...sample,
    attemptProvenance: provenance,
    source,
    rawPages: {
      jobs: rawPages.jobs ?? packet.jobsPages ?? {status: 'missing', endpoint: packet.endpoint ?? null},
      steps: rawPages.steps ?? {status: 'embedded-in-jobs', endpoint: packet.endpoint ?? null},
      artifacts: rawPages.artifacts ?? packet.artifactPages ?? {status: 'missing', endpoint: packet.artifactEndpoint ?? null},
      cache: rawPages.cache ?? packet.cachePages ?? {status: 'missing', endpoint: packet.cacheEndpoint ?? null},
      runner: rawPages.runner ?? {status: 'embedded-in-jobs', endpoint: packet.endpoint ?? null},
    },
    steps: jobs.flatMap((job) => job.steps.map((step) => ({jobName: job.name, ...step}))),
    artifacts: normalizePacketArtifacts(packet.artifacts),
    cache: normalizePacketCache(packet.cache),
    artifactObservation: packet.artifactObservation ? structuredClone(packet.artifactObservation) : null,
    runnerRoster: normalizeRunnerRoster(jobs),
  };
}

function timingValue(job, camelName, rawName) {
  return job?.[camelName] ?? job?.[rawName] ?? null;
}

function timingDifference(later, earlier) {
  const laterSeconds = dateSeconds(later);
  const earlierSeconds = dateSeconds(earlier);
  if (laterSeconds === null || earlierSeconds === null) {
    return {status: later === null || earlier === null ? 'missing' : 'invalid', value: null};
  }
  if (laterSeconds < earlierSeconds) return {status: 'invalid', value: null};
  return {status: 'observed', value: laterSeconds - earlierSeconds};
}

function timingNoClaim(code, expected, observed, hint, provenance) {
  const error = contractError(code, 'timing observation cannot support a numeric fact', {
    expected,
    observed,
    hint,
    affectedProvenance: provenance,
  });
  return toStructuredError(error);
}

function pathTiming(criticalPath, requiredContexts, provenance) {
  if (!criticalPath || criticalPath.status !== 'observed' || !Array.isArray(criticalPath.members) || criticalPath.members.length === 0 || !Number.isFinite(criticalPath.totalSeconds) || criticalPath.totalSeconds < 0) {
    return {
      status: 'no-claim',
      members: [],
      totalSeconds: null,
      attemptProvenance: provenance,
      noClaim: timingNoClaim(
        'critical-path-timing-invalid',
        'an observed critical path with at least one member and a finite nonnegative total',
        {
          status: criticalPath?.status ?? 'missing',
          members: criticalPath?.members ?? null,
          totalSeconds: criticalPath?.totalSeconds ?? null,
        },
        'Recollect every accepted path member with finite nonnegative timing for this exact attempt.',
        provenance,
      ),
    };
  }
  if (criticalPath.attemptProvenance && stableJson(criticalPath.attemptProvenance) !== stableJson(provenance)) {
    return {
      status: 'no-claim',
      members: [],
      totalSeconds: null,
      attemptProvenance: provenance,
      noClaim: timingNoClaim(
        'critical-path-provenance-mismatch',
        provenance,
        criticalPath.attemptProvenance,
        'Re-derive critical path and cost facts from the same accepted attempt packet.',
        provenance,
      ),
    };
  }
  const memberTiming = Array.isArray(criticalPath.timing) ? criticalPath.timing : [];
  const timingByName = new Map(memberTiming.map((timing) => [timing?.name, timing]));
  if (timingByName.size !== criticalPath.members.length || criticalPath.members.some((name) => {
    const timing = timingByName.get(name);
    return !Number.isFinite(timing?.activeSeconds) || timing.activeSeconds < 0;
  })) {
    return {
      status: 'no-claim',
      members: [],
      totalSeconds: null,
      attemptProvenance: provenance,
      noClaim: timingNoClaim(
        'critical-path-timing-invalid',
        'one nonnegative timing value for every path member',
        criticalPath.timing ?? null,
        'Recollect complete nonnegative timing for every accepted path member.',
        provenance,
      ),
    };
  }
  const requiredNames = new Set(requiredContexts.map((required) => required?.jobName ?? requiredContextName(required)));
  const required = memberTiming.filter((timing) => requiredNames.has(timing?.name));
  return {
    status: 'observed',
    members: criticalPath.members,
    totalSeconds: Number.isFinite(criticalPath.totalSeconds) && criticalPath.totalSeconds >= 0
      ? criticalPath.totalSeconds
      : null,
    memberTiming,
    attemptProvenance: provenance,
    ...(required.length > 0 ? {requiredMemberTiming: required} : {}),
  };
}

function requiredContextTiming(criticalPath, requiredContexts, provenance) {
  if (!criticalPath || criticalPath.status !== 'observed') {
    return {status: 'no-claim', members: [], totalSeconds: null, attemptProvenance: provenance};
  }
  const requiredNames = new Set(requiredContexts.map((required) => required?.jobName ?? requiredContextName(required)));
  const timing = (criticalPath.timing ?? []).filter((entry) => requiredNames.has(entry?.name));
  if (timing.some((entry) => !Number.isFinite(entry.activeSeconds) || entry.activeSeconds < 0)) {
    return {status: 'unknown', members: timing.map((entry) => entry.name), totalSeconds: null, attemptProvenance: provenance};
  }
  return {
    status: 'observed',
    members: timing.map((entry) => entry.name),
    totalSeconds: timing.reduce((sum, entry) => sum + entry.activeSeconds, 0),
    attemptProvenance: provenance,
  };
}

function artifactFacts(artifacts, provenance, observation = null) {
  const artifact = Array.isArray(artifacts) && artifacts.length === 1 ? artifacts[0] : null;
  const id = positiveInteger(artifact?.id) ? artifact.id : null;
  const digest = typeof artifact?.digest === 'string' && artifact.digest.length > 0 ? artifact.digest : null;
  const archiveBytes = artifact?.sizeInBytes ?? artifact?.size_in_bytes ?? null;
  const expandedInputBytes = artifact?.expandedInputBytes ?? artifact?.expanded_input_bytes ?? null;
  const expandedOutputBytes = artifact?.expandedOutputBytes ?? artifact?.expanded_output_bytes ?? null;
  if (id === null || digest === null) {
    return {
      status: 'unknown',
      identity: null,
      archiveBytes: null,
      expandedInputBytes: null,
      expandedOutputBytes: null,
      attemptProvenance: provenance,
      noClaim: budgetIssue(
        observation?.status === 'api-read-failed' ? 'artifact-api-read-failed' : observation?.status === 'missing-packet' ? 'artifact-packet-missing' : 'artifact-observation-unknown',
        'artifact id, digest, and archive byte observation',
        {id, digest, archiveBytes},
        'Collect the artifact metadata packet for this exact attempt; do not infer identity from its name.',
        provenance,
      ),
      ...(observation?.endpoint ? {endpoint: observation.endpoint} : {}),
      ...(observation?.error ? {error: structuredClone(observation.error)} : {}),
    };
  }
  const result = {
    status: 'observed',
    identity: {id, digest},
    archiveBytes: Number.isInteger(archiveBytes) && archiveBytes >= 0 ? archiveBytes : null,
    expandedInputBytes: Number.isInteger(expandedInputBytes) && expandedInputBytes >= 0 ? expandedInputBytes : null,
    expandedOutputBytes: Number.isInteger(expandedOutputBytes) && expandedOutputBytes >= 0 ? expandedOutputBytes : null,
    attemptProvenance: provenance,
  };
  const unknownField = result.archiveBytes === null
    ? 'archiveBytes'
    : result.expandedInputBytes === null
      ? 'expandedInputBytes'
      : result.expandedOutputBytes === null
        ? 'expandedOutputBytes'
        : null;
  if (unknownField) {
    result.noClaim = budgetIssue(
      'artifact-bytes-unknown',
      'archive and explicitly observed expanded byte values',
      {unknownField, archiveBytes: result.archiveBytes, expandedInputBytes: result.expandedInputBytes, expandedOutputBytes: result.expandedOutputBytes},
      'Collect the missing archive or producer/consumer expansion inventory; do not replace unknown bytes with zero.',
      provenance,
    );
  }
  return result;
}

function cacheFacts(cache, provenance) {
  const status = ['hit', 'miss', 'unknown'].includes(cache?.status) ? cache.status : 'unknown';
  const result = {
    status,
    ...(typeof cache?.key === 'string' ? {key: cache.key} : {}),
    attemptProvenance: provenance,
  };
  if (status === 'unknown') {
    result.noClaim = budgetIssue(
      'cache-observation-unknown',
      'cache hit or miss observation for this exact attempt',
      cache ?? {status: 'unknown'},
      'Collect the cache observation for this attempt; keep unknown and do not estimate savings.',
      provenance,
    );
  }
  return result;
}

export function deriveCostFacts(packet, {
  criticalPath = null,
  requiredContexts = [],
} = {}) {
  requireObject(packet, 'packet-invalid', 'cost facts require an attempt packet');
  const provenance = createAttemptProvenance(packet.attemptProvenance);
  const run = packet.run ?? {};
  const jobs = Array.isArray(packet.jobs) ? packet.jobs : [];
  const createdAt = timingValue(run, 'createdAt', 'created_at');
  const startedAt = timingValue(run, 'runStartedAt', 'run_started_at');
  const admission = timingDifference(startedAt, createdAt);
  const jobIntervals = jobs.map((job) => ({
    name: job.name,
    queue: timingDifference(timingValue(job, 'startedAt', 'started_at'), timingValue(job, 'createdAt', 'created_at')),
    active: timingDifference(timingValue(job, 'completedAt', 'completed_at'), timingValue(job, 'startedAt', 'started_at')),
  }));
  const firstStarted = jobs.map((job) => dateSeconds(timingValue(job, 'startedAt', 'started_at'))).filter((value) => value !== null).sort((a, b) => a - b)[0];
  const lastCompleted = jobs.map((job) => dateSeconds(timingValue(job, 'completedAt', 'completed_at'))).filter((value) => value !== null).sort((a, b) => a - b).at(-1);
  const wallClock = timingDifference(
    lastCompleted === undefined ? null : new Date(lastCompleted * 1000).toISOString(),
    firstStarted === undefined ? null : new Date(firstStarted * 1000).toISOString(),
  );
  const allIntervals = [admission, wallClock, ...jobIntervals.flatMap((interval) => [interval.queue, interval.active])];
  const invalid = allIntervals.find((interval) => interval.status === 'invalid');
  const missing = allIntervals.find((interval) => interval.status === 'missing');
  const timingStatus = invalid ? 'unknown' : missing ? 'unknown' : 'observed';
  const timing = {
    status: timingStatus,
    admissionSeconds: timingStatus === 'observed' ? admission.value : null,
    queueSeconds: timingStatus === 'observed' ? Math.max(...jobIntervals.map((interval) => interval.queue.value)) : null,
    activeSeconds: timingStatus === 'observed' ? wallClock.value : null,
    wallClockSeconds: timingStatus === 'observed' ? wallClock.value : null,
    byJob: jobIntervals.map((interval) => ({name: interval.name, queueSeconds: interval.queue.value, activeSeconds: interval.active.value})),
    attemptProvenance: provenance,
    ...(timingStatus === 'unknown'
      ? {noClaim: timingNoClaim(
        invalid ? 'timing-observation-invalid' : 'timing-observation-missing',
        'nonnegative, parseable timestamps for run and every observed job',
        {missing: jobs.filter((job) => jobIntervals.find((interval) => interval.name === job.name)?.queue.value === null).map((job) => job.name)},
        'Collect created, started, and completed timestamps for this exact attempt and retry.',
        provenance,
      )}
      : {}),
  };
  return {
    status: timingStatus === 'observed' ? 'observed' : 'unknown',
    attemptProvenance: provenance,
    timing,
    acceptedPathTiming: pathTiming(criticalPath, requiredContexts, provenance),
    requiredContextTiming: requiredContextTiming(criticalPath, requiredContexts, provenance),
    artifact: artifactFacts(packet.artifacts, provenance, packet.artifactObservation),
    cache: cacheFacts(packet.cache, provenance),
  };
}

function readinessNoClaim(code, expected, observed, hint, provenance, observations = []) {
  const error = contractError(code, 'readiness observations cannot be joined safely', {
    expected,
    observed,
    hint,
    affectedProvenance: provenance,
  });
  return {
    status: 'no-claim',
    delaySeconds: null,
    observations,
    attemptProvenance: provenance,
    noClaim: toStructuredError(error),
  };
}

function readinessIdentity(observation) {
  return {
    sourceSha: observation?.sourceSha ?? null,
    runId: observation?.runId ?? null,
    runAttempt: observation?.runAttempt ?? null,
    artifactId: observation?.artifactId ?? null,
    artifactDigest: observation?.artifactDigest ?? null,
  };
}

function sameAttemptIdentity(observation, provenance) {
  return observation?.sourceSha === provenance.sourceSha &&
    observation?.runId === provenance.runId &&
    observation?.runAttempt === provenance.runAttempt;
}

function validObservationKind(observation, expectedPrefix) {
  return typeof observation?.observationKind === 'string' &&
    observation.observationKind.trim().length > 0 &&
    (!expectedPrefix || observation.observationKind.startsWith(expectedPrefix));
}

function validConsumerIdentity(observation) {
  return typeof observation?.consumerIdentity === 'string' && observation.consumerIdentity.trim().length > 0;
}

function sameArtifactIdentity(producer, consumer) {
  return positiveInteger(producer?.artifactId) &&
    positiveInteger(consumer?.artifactId) &&
    producer.artifactId === consumer.artifactId &&
    typeof producer.artifactDigest === 'string' &&
    producer.artifactDigest.length > 0 &&
    producer.artifactDigest === consumer.artifactDigest;
}

function joinReadinessConsumers(producer, consumers, provenance, producerSeconds) {
  const joined = [];
  for (const consumer of consumers) {
    if (!sameAttemptIdentity(consumer, provenance)) {
      return {failure: readinessNoClaim(
        'readiness-provenance-mismatch',
        readinessIdentity(provenance),
        {consumer: readinessIdentity(consumer)},
        'Collect producer and consumer observations from the exact source, run, and attempt; do not join by name.',
        provenance,
        joined,
      )};
    }
    if (!sameArtifactIdentity(producer, consumer)) {
      return {failure: readinessNoClaim(
        'readiness-artifact-identity-mismatch',
        {artifactId: producer.artifactId, artifactDigest: producer.artifactDigest},
        {artifactId: consumer.artifactId, artifactDigest: consumer.artifactDigest, artifactName: consumer.artifactName ?? null},
        'Join readiness by artifact id and digest; an artifact name is not an identity.',
        provenance,
        joined,
      )};
    }
    const consumerSeconds = dateSeconds(consumer.observedStart);
    if (consumerSeconds === null) {
      return {failure: readinessNoClaim(
        'readiness-time-invalid',
        'parseable consumer observedStart timestamp',
        {consumer: readinessIdentity(consumer), observedStart: consumer.observedStart ?? null},
        'Collect a parseable consumer observation timestamp from the same attempt.',
        provenance,
        joined,
      )};
    }
    if (consumerSeconds < producerSeconds) {
      return {failure: readinessNoClaim(
        'readiness-time-reversed',
        'consumer observed start at or after producer ready time',
        {producerReady: producer.readyAt, consumerObservedStart: consumer.observedStart},
        'Check observation clocks and provenance; do not emit a negative readiness delay.',
        provenance,
        joined,
      )};
    }
    if (!validConsumerIdentity(consumer) || !validObservationKind(consumer, 'download-') || !validObservationKind(producer, 'upload-')) {
      return {failure: readinessNoClaim(
        'readiness-observation-invalid',
        'producer upload-* and consumer download-* observationKind plus non-empty consumerIdentity',
        {producerObservationKind: producer?.observationKind ?? null, consumer: readinessIdentity(consumer), consumerIdentity: consumer?.consumerIdentity ?? null, observationKind: consumer?.observationKind ?? null},
        'Record both concrete observation kinds and the consumer identity before joining readiness.',
        provenance,
        joined,
      )};
    }
    joined.push({
      producer: {identity: {id: producer.artifactId, digest: producer.artifactDigest}, observedAt: producer.readyAt},
      consumer: {identity: consumer.consumerIdentity, observedAt: consumer.observedStart},
      delaySeconds: consumerSeconds - producerSeconds,
      attemptProvenance: provenance,
    });
  }
  return {joined};
}

export function deriveReadiness(packet, observations) {
  requireObject(packet, 'packet-invalid', 'readiness requires an attempt packet');
  const provenance = createAttemptProvenance(packet.attemptProvenance);
  requireObject(observations, 'readiness-observations-invalid', 'readiness observations are missing');
  const producer = observations.producer;
  const consumers = Array.isArray(observations.consumers) ? observations.consumers : [];
  if (!producer) {
    return readinessNoClaim(
      'readiness-producer-missing',
      'one producerReady observation',
      {producer: null, consumerCount: consumers.length},
      'Collect the producer upload observation from the same attempt before joining readiness.',
      provenance,
    );
  }
  if (consumers.length === 0) {
    return readinessNoClaim(
      'readiness-consumer-missing',
      'at least one consumerObservedStart observation',
      {producer: readinessIdentity(producer), consumerCount: 0},
      'Collect every consumer start observation for the same artifact identity and attempt.',
      provenance,
    );
  }
  if (!sameAttemptIdentity(producer, provenance)) {
    return readinessNoClaim(
      'readiness-provenance-mismatch',
      readinessIdentity(provenance),
      {producer: readinessIdentity(producer)},
      'Collect producer and consumer observations from the exact source, run, and attempt; do not join by name.',
      provenance,
    );
  }
  const producerSeconds = dateSeconds(producer.readyAt);
  if (producerSeconds === null) {
    return readinessNoClaim(
      'readiness-time-invalid',
      'parseable producer readyAt timestamp',
      {producer: readinessIdentity(producer), readyAt: producer.readyAt ?? null},
      'Collect a parseable producer observation timestamp from the same attempt.',
      provenance,
    );
  }
  const joinedResult = joinReadinessConsumers(producer, consumers, provenance, producerSeconds);
  if (joinedResult.failure) return joinedResult.failure;
  const joined = joinedResult.joined;
  return {
    status: 'observed',
    delaySeconds: joined.length === 1 ? joined[0].delaySeconds : null,
    observations: joined,
    attemptProvenance: provenance,
  };
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

function budgetIssue(code, expected, observed, hint, affectedProvenance) {
  return toStructuredError(contractError(code, 'budget claim cannot be formed safely', {
    expected,
    observed,
    hint,
    affectedProvenance,
  }));
}

function budgetNoClaim(code, expected, observed, hint, facts, rejected, provenance) {
  return {
    status: 'no-claim',
    successfulExactStableRosterCount: facts.filter((sample) => sample._budgetEligible === true).length,
    minimumRequired: MINIMUM_STABLE_ROSTER,
    facts: facts.map((sample) => {
      const copy = structuredClone(sample);
      delete copy._budgetEligible;
      return copy;
    }),
    rejected,
    budgetClaim: null,
    noClaim: budgetIssue(code, expected, observed, hint, provenance),
  };
}

function sameBudgetTopology(provenance, topology) {
  return provenance.topologyId === topology?.topologyId &&
    provenance.graphDigest === topology?.graphDigest &&
    provenance.rosterKey === topology?.rosterKey &&
    stableJson(provenance.workflow) === stableJson(topology?.workflow);
}

function sampleSuccess(sample, successCondition) {
  const run = sample.run ?? {};
  const jobs = Array.isArray(sample.jobs) ? sample.jobs : [];
  return run.status === (successCondition?.runStatus ?? 'completed') &&
    run.conclusion === (successCondition?.runConclusion ?? 'success') &&
    jobs.length > 0 &&
    jobs.every((job) => job.status === (successCondition?.jobStatus ?? 'completed') &&
      job.conclusion === (successCondition?.jobConclusion ?? 'success'));
}

function budgetSampleFailure(sample, options, seenAttempts) {
  const {acceptedTopology, expectedJobNames, expectedSourceSha, successCondition} = options;
  let provenance;
  try {
    validateComparableSample(sample, {expectedJobNames});
    provenance = createAttemptProvenance(sample.attemptProvenance);
  } catch (error) {
    const code = error?.code === 'roster-mismatch' ? 'budget-population-roster-mismatch' : 'budget-population-invalid-sample';
    return {code, expected: expectedJobNames, observed: sample, hint: 'Collect one complete terminal packet with the admitted exact roster.'};
  }
  const attemptKey = `${provenance.runId}:${provenance.runAttempt}`;
  if (seenAttempts.has(attemptKey)) {
    return {code: 'budget-population-attempt-duplicate', expected: 'one independent run attempt per sample', observed: attemptKey, hint: 'Keep retry attempts separate and collect another independent run.'};
  }
  seenAttempts.add(attemptKey);
  if (expectedSourceSha !== undefined && provenance.sourceSha !== expectedSourceSha) {
    return {code: 'budget-population-source-mismatch', expected: expectedSourceSha, observed: provenance.sourceSha, hint: 'Limit the population to the accepted source identity before claiming a budget.'};
  }
  if (!sameBudgetTopology(provenance, acceptedTopology)) {
    return {code: 'budget-population-topology-mismatch', expected: acceptedTopology, observed: provenance, hint: 'Limit the population to one accepted workflow topology and recollect the missing samples.'};
  }
  if (sample.rosterKey !== provenance.rosterKey) {
    return {code: 'budget-population-roster-mismatch', expected: provenance.rosterKey, observed: sample.rosterKey, hint: 'Collect packets whose roster key and provenance roster agree exactly.'};
  }
  if (!sampleSuccess(sample, successCondition)) {
    return {code: 'budget-population-failure-mixed', expected: successCondition, observed: {run: sample.run, jobs: sample.jobs}, hint: 'Remove failed or non-success samples and collect another successful terminal attempt.'};
  }
  return null;
}

export function successfulExactStableRosterPopulation(samples, options = {}) {
  if (!Array.isArray(samples)) throw contractError('budget-population-invalid', 'budget population must be an array');
  const facts = samples.map((sample) => structuredClone(sample));
  const rejected = [];
  const seenAttempts = new Set();
  const provenance = [];
  for (const [index, sample] of facts.entries()) {
    const failure = budgetSampleFailure(sample, options, seenAttempts);
    if (failure) {
      rejected.push({index, code: failure.code, expected: failure.expected, observed: failure.observed});
      sample._budgetEligible = false;
    } else {
      sample._budgetEligible = true;
      provenance.push(structuredClone(sample.attemptProvenance));
    }
  }
  const eligibleCount = facts.filter((sample) => sample._budgetEligible === true).length;
  const cleanFacts = facts.map((sample) => {
    const copy = structuredClone(sample);
    delete copy._budgetEligible;
    return copy;
  });
  if (rejected.length > 0) {
    const first = rejected[0];
    return budgetNoClaim(first.code, first.expected, first.observed, 'Narrow the input to independent successful packets with one source, roster, and accepted topology.', facts, rejected, provenance);
  }
  if (eligibleCount < MINIMUM_STABLE_ROSTER) {
    return {
      status: 'no-claim',
      successfulExactStableRosterCount: eligibleCount,
      minimumRequired: MINIMUM_STABLE_ROSTER,
      facts: cleanFacts,
      rejected,
      budgetClaim: null,
      noClaim: budgetIssue(
        'budget-population-insufficient',
        `at least ${MINIMUM_STABLE_ROSTER} successful exact stable-roster samples`,
        eligibleCount,
        `Collect ${MINIMUM_STABLE_ROSTER - eligibleCount} more independent successful attempts to reach ${MINIMUM_STABLE_ROSTER} before claiming a budget.`,
        provenance,
      ),
    };
  }
  const claim = {
    status: 'claimed',
    owner: options.owner,
    sampleCount: eligibleCount,
    successCondition: options.successCondition?.label ?? 'completed run and every admitted job concluded success',
    topology: structuredClone(options.acceptedTopology),
    provenance,
  };
  const validation = validateBudgetClaim(claim, {...options, provenanceSet: provenance});
  if (!validation.ok) return budgetNoClaim(validation.error.code, validation.error.expected, validation.error.observed, validation.error.hint, cleanFacts, rejected, provenance);
  return {
    status: 'observed',
    successfulExactStableRosterCount: eligibleCount,
    minimumRequired: MINIMUM_STABLE_ROSTER,
    facts: cleanFacts,
    rejected,
    budgetClaim: claim,
  };
}

function budgetClaimValidationFailure(code, expected, observed, hint) {
  return {ok: false, error: budgetIssue(code, expected, observed, hint, observed?.provenance ?? null)};
}

export function validateBudgetClaim(claim, {
  owner,
  acceptedTopology,
  successCondition,
  provenanceSet,
  minimum = MINIMUM_STABLE_ROSTER,
} = {}) {
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) {
    return budgetClaimValidationFailure('budget-claim-missing', 'an owner-bound budget claim object', claim, 'Collect a complete population before validating a budget claim.');
  }
  const required = ['owner', 'sampleCount', 'successCondition', 'topology', 'provenance'];
  const missing = required.find((field) => claim[field] === undefined || claim[field] === null);
  if (missing) return budgetClaimValidationFailure('budget-claim-prerequisite-missing', required, missing, `Restore ${missing} from the same baseline population before validating the claim.`);
  if (claim.owner !== owner) return budgetClaimValidationFailure('budget-claim-owner-mismatch', owner, claim.owner, 'Use the baseline owner that produced the population facts.');
  if (!Number.isInteger(claim.sampleCount) || claim.sampleCount < minimum) return budgetClaimValidationFailure('budget-claim-count-insufficient', `integer sampleCount >= ${minimum}`, claim.sampleCount, `Collect at least ${minimum} successful independent attempts.`);
  if (claim.successCondition !== (successCondition?.label ?? successCondition)) return budgetClaimValidationFailure('budget-claim-success-condition-mismatch', successCondition, claim.successCondition, 'Use the exact successful terminal condition for this baseline owner.');
  if (stableJson(claim.topology) !== stableJson(acceptedTopology)) return budgetClaimValidationFailure('budget-claim-topology-mismatch', acceptedTopology, claim.topology, 'Use one accepted topology and exact roster for every claim sample.');
  if (!Array.isArray(claim.provenance) || claim.provenance.length !== claim.sampleCount || !Array.isArray(provenanceSet)) {
    return budgetClaimValidationFailure('budget-claim-provenance-missing', 'one provenance entry per sample', claim.provenance, 'Retain every attempt provenance entry so the claim can be audited.');
  }
  const expected = new Set(provenanceSet.map((entry) => stableJson(createAttemptProvenance(entry))));
  const actual = new Set();
  try {
    for (const entry of claim.provenance) actual.add(stableJson(createAttemptProvenance(entry)));
  } catch (error) {
    return budgetClaimValidationFailure('budget-claim-provenance-invalid', 'complete attempt provenance entries', claim.provenance, 'Recollect the missing source, run, attempt, topology, roster, or workflow identity.');
  }
  if (actual.size !== expected.size || [...actual].some((entry) => !expected.has(entry))) {
    return budgetClaimValidationFailure('budget-claim-provenance-mismatch', provenanceSet, claim.provenance, 'Keep the exact provenance set that produced the claim; do not fold retries or replace identities.');
  }
  return {ok: true, claim};
}

export function validateBaselineEvidence(value) {
  requireObject(value, 'baseline-evidence-invalid', 'baseline evidence must be an object');
  if (value.schemaVersion !== BASELINE_SCHEMA_VERSION) {
    throw contractError('baseline-evidence-schema-invalid', BASELINE_SCHEMA_VERSION, {
      expected: BASELINE_SCHEMA_VERSION,
      observed: value.schemaVersion ?? null,
      hint: 'Read a collector-produced forgeax-ci-baseline/v2 document.',
      affectedProvenance: value.attemptProvenance ?? null,
    });
  }
  const noClaims = Array.isArray(value.noClaim) ? value.noClaim : value.noClaim ? [value.noClaim] : [];
  if (value.attemptProvenance === null || value.attemptProvenance === undefined) {
    const missingPacket = noClaims.some((claim) => claim?.code === 'attempt-packet-missing');
    if (!missingPacket) {
      throw contractError('attempt-provenance-missing', 'baseline evidence has no complete attempt provenance', {
        expected: ATTEMPT_PROVENANCE_FIELDS,
        observed: value.attemptProvenance ?? null,
        hint: 'Provide one exact attempt packet or an explicit attempt-packet-missing no-claim.',
        affectedProvenance: value.attemptProvenance ?? null,
      });
    }
    return value;
  }
  const provenance = createAttemptProvenance(value.attemptProvenance);
  const blocks = [value.criticalPath, value.requiredContexts, value.costFacts, value.readiness]
    .filter((block) => block && block.attemptProvenance);
  if (blocks.length > 0) assertSameAttemptProvenance([{attemptProvenance: provenance}, ...blocks]);
  if (value.budgetClaim !== null && value.budgetClaim !== undefined && typeof value.budgetClaim !== 'object') {
    throw contractError('baseline-budget-claim-invalid', 'baseline budgetClaim must be an object or null', {
      expected: 'object or null',
      observed: value.budgetClaim,
      affectedProvenance: provenance,
    });
  }
  return value;
}
