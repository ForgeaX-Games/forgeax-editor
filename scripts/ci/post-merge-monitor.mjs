#!/usr/bin/env node

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CONTRACT_SCHEMA_VERSION, validateRuntimeProjection } from './editor-ci-contract.mjs';
import {
  createDeliveryEnvelope,
  LANDED_REQUIRED_CONTEXTS,
} from './editor-ci-contract-envelope.mjs';
import { discoverLiveRuleset, requiredContextNamesFromRuleset } from './live-ruleset-admission.mjs';

const MAX_EVIDENCE = 4;
const MAX_DETAIL_LENGTH = 220;
const MAX_LOG_LENGTH = 16000;

export const CLASSIFICATIONS = Object.freeze([
  'success',
  'repository-source-failure',
  'deterministic-environment-failure',
  'external-transport-failure',
  'genuine-cancellation',
  'cancellation-superseded-by-newer-run',
  'duplicate-same-sha-delivery',
]);

export const POST_MERGE_CONTRACT_VERSION = CONTRACT_SCHEMA_VERSION;
const POST_MERGE_EXECUTION_HOME = 'post-merge';
const POST_MERGE_TIMING_DOMAIN = 'post-merge-workflow';
const FAILURE_CLASSES = new Set(['admission', 'environment', 'source', 'external-transport']);

function structuredError(code, expected, observed, hint) {
  return { ok: false, error: { code, expected: typeof expected === 'string' ? expected : JSON.stringify(expected), observed, hint } };
}

function nonEmptyIdentity(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    return structuredError(`${name}-missing`, `non-empty ${name}`, value, `Provide ${name} from the workflow_run event.`);
  }
  return { ok: true, value };
}

function postMergeProvenance({ workflowRun, targetSha, monitorSha, job }) {
  return {
    kind: 'cloud',
    timingDomain: POST_MERGE_TIMING_DOMAIN,
    targetSha,
    runId: workflowRun.id,
    attempt: workflowRun.run_attempt,
    htmlUrl: workflowRun.html_url,
    jobId: job?.id ?? null,
    jobName: job?.name ?? null,
    monitorSha: monitorSha ?? null,
  };
}

function failureFields(failureClass, code, observed, hint, attempt = 1) {
  const expected = 'the target-SHA post-merge evidence is valid';
  const firstFailure = {
    attempt,
    attemptId: `attempt-${attempt}`,
    code,
    expected,
    observed,
  };
  return {
    terminalStatus: 'failure',
    failureClass,
    code,
    expected,
    observed,
    hint,
    firstFailure,
  };
}

function successFields() {
  return {
    terminalStatus: 'pass',
    failureClass: null,
    code: null,
    expected: 'the target workflow job succeeds',
    observed: 'success',
    hint: 'No recovery action is required.',
    firstFailure: null,
  };
}

function admissionEnvelope({ workflowRun, targetSha, monitorSha, failureClass, code, observed, hint }) {
  return {
    contractVersion: POST_MERGE_CONTRACT_VERSION,
    checkId: 'post-merge',
    owner: 'editor-ci',
    profile: 'post-merge',
    executionHome: POST_MERGE_EXECUTION_HOME,
    provenance: postMergeProvenance({ workflowRun, targetSha, monitorSha }),
    ...failureFields(failureClass, code, observed, hint, workflowRun.run_attempt ?? 1),
    attempts: [
      {
        attempt: workflowRun.run_attempt ?? 1,
        attemptId: `attempt-${workflowRun.run_attempt ?? 1}`,
        status: 'failure',
        transient: failureClass === 'external-transport',
      },
    ],
    sloClaim: null,
  };
}

function failureClassForClassification(classification) {
  if (classification === 'external-transport-failure') return 'external-transport';
  if (classification === 'deterministic-environment-failure') return 'environment';
  if (classification === 'success') return null;
  if (classification === 'duplicate-same-sha-delivery') return 'admission';
  return 'source';
}

function finalizeFinding(finding, run) {
  finding.failureClass = failureClassForClassification(finding.classification);
  finding.terminalStatus = finding.red ? 'failure' : 'pass';
  finding.code = finding.evidence[0]?.code ?? finding.classification;
  finding.expected = 'the completed workflow run has a valid target-SHA result';
  finding.observed = finding.red ? `classification=${finding.classification}` : 'success';
  finding.hint = finding.red ? 'Use failureClass and firstFailure to choose recovery.' : 'No recovery action is required.';
  finding.provenance = {
    kind: 'cloud',
    timingDomain: POST_MERGE_TIMING_DOMAIN,
    targetSha: finding.head_sha,
    runId: run.id,
    attempt: run.run_attempt ?? 1,
    htmlUrl: finding.html_url,
    monitorSha: null,
  };
  finding.attempts = [
    {
      attempt: run.run_attempt ?? 1,
      attemptId: `run-${run.id}-attempt-${run.run_attempt ?? 1}`,
      status: finding.terminalStatus,
      transient: finding.failureClass === 'external-transport',
    },
  ];
  finding.firstFailure = finding.red
    ? {
        attempt: run.run_attempt ?? 1,
        attemptId: `run-${run.id}-attempt-${run.run_attempt ?? 1}`,
        code: finding.code,
        expected: finding.expected,
        observed: finding.observed,
      }
    : null;
  finding.sloClaim = null;
  return finding;
}

const EXTERNAL_SIGNATURES = Object.freeze([
  { code: 'connection-reset', pattern: /\bECONNRESET\b|connection reset by peer/i },
  { code: 'connection-timeout', pattern: /\bETIMEDOUT\b|TLS handshake timeout|timed out while connecting/i },
  { code: 'transient-dns', pattern: /\bEAI_AGAIN\b|temporary failure in name resolution/i },
  { code: 'http-502', pattern: /\b502\s+Bad Gateway\b/i },
  { code: 'http-503', pattern: /\b503\s+Service Unavailable\b/i },
]);

const ENVIRONMENT_SIGNATURES = Object.freeze([
  { code: 'runner-capability-missing', pattern: /runner[^\n]{0,80}(offline|not found|unavailable)/i },
  { code: 'tool-not-installed', pattern: /command not found|executable file not found/i },
  { code: 'workspace-storage-exhausted', pattern: /no space left on device/i },
  { code: 'browser-runtime-missing', pattern: /could not find (?:a )?(?:chromium|chrome|browser) executable/i },
  { code: 'environment-permission-denied', pattern: /permission denied.*(?:runner|workspace|cache|toolchain)/i },
]);

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function requireRunIdentity(run) {
  const headSha = nonEmptyString(run?.head_sha);
  const htmlUrl = nonEmptyString(run?.html_url);
  if (!headSha || !htmlUrl) {
    throw new Error('workflow_run.head_sha and workflow_run.html_url are required');
  }
  return { head_sha: headSha, html_url: htmlUrl };
}

function comparableTime(run) {
  const timestamp = Date.parse(run?.created_at ?? '');
  if (Number.isFinite(timestamp)) return timestamp;
  if (Number.isFinite(run?.run_number)) return run.run_number;
  return Number.isFinite(run?.id) ? run.id : null;
}

function sameDeliveryScope(current, candidate) {
  const workflowMatches =
    current?.workflow_id == null || candidate?.workflow_id == null || current.workflow_id === candidate.workflow_id;
  const branchMatches =
    current?.head_branch == null || candidate?.head_branch == null || current.head_branch === candidate.head_branch;
  const eventMatches = current?.event == null || candidate?.event == null || current.event === candidate.event;
  return workflowMatches && branchMatches && eventMatches;
}

function isOlder(candidate, current) {
  const candidateTime = comparableTime(candidate);
  const currentTime = comparableTime(current);
  if (candidateTime == null || currentTime == null) return false;
  return candidateTime < currentTime || (candidateTime === currentTime && candidate.id < current.id);
}

function isNewer(candidate, current) {
  const candidateTime = comparableTime(candidate);
  const currentTime = comparableTime(current);
  if (candidateTime == null || currentTime == null) return false;
  return candidateTime > currentTime || (candidateTime === currentTime && candidate.id > current.id);
}

function boundedDetail(value) {
  return String(value).replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL_LENGTH);
}

function addEvidence(evidence, code, detail) {
  if (evidence.length >= MAX_EVIDENCE) return;
  const entry = { code, detail: boundedDetail(detail) };
  if (!evidence.some((existing) => existing.code === entry.code && existing.detail === entry.detail)) {
    evidence.push(entry);
  }
}

function firstFailedJob(jobs) {
  return jobs.find((job) => ['failure', 'timed_out', 'startup_failure', 'action_required'].includes(job?.conclusion));
}

function firstFailedStep(job) {
  return job?.steps?.find((step) => ['failure', 'timed_out', 'startup_failure', 'action_required'].includes(step?.conclusion));
}

function findSignatures(logText, signatures) {
  const boundedLog = String(logText ?? '').slice(0, MAX_LOG_LENGTH);
  return signatures.filter(({ pattern }) => pattern.test(boundedLog));
}

/**
 * Convert GitHub's failed-job payload and a bounded failed-log sample into
 * normalized, non-secret evidence. Raw log text never leaves this function.
 */
export function deriveFailureEvidence({ jobs = [], logText = '' } = {}) {
  const evidence = [];
  const job = firstFailedJob(Array.isArray(jobs) ? jobs : []);
  const step = firstFailedStep(job);

  if (job) {
    addEvidence(
      evidence,
      'failed-job',
      `job=${job.name ?? job.id ?? 'unknown'} conclusion=${job.conclusion ?? 'unknown'}`,
    );
  }
  if (step) addEvidence(evidence, 'failed-step', `step=${step.name ?? step.number ?? 'unknown'}`);

  const external = findSignatures(logText, EXTERNAL_SIGNATURES);
  const environment = findSignatures(logText, ENVIRONMENT_SIGNATURES);
  for (const match of external) addEvidence(evidence, match.code, 'bounded failed-log signature');
  for (const match of environment) addEvidence(evidence, match.code, 'bounded failed-log signature');

  return {
    evidence,
    externalTransport: external.length > 0,
    deterministicEnvironment: environment.length > 0,
  };
}

function validatePostMergeIdentity(envelope, expected = {}) {
  const expectedContractVersion = expected.contractVersion ?? POST_MERGE_CONTRACT_VERSION;
  if (envelope?.contractVersion !== expectedContractVersion) {
    return structuredError(
      'contract-version-mismatch',
      expectedContractVersion,
      envelope?.contractVersion,
      'Use the contract version that produced this post-merge evidence.',
    );
  }
  if (expected.targetSha !== undefined && envelope?.provenance?.targetSha !== expected.targetSha) {
    return structuredError(
      'target-sha-mismatch',
      expected.targetSha,
      envelope?.provenance?.targetSha,
      'Attribute evidence to workflow_run.head_sha; never use the monitor checkout SHA.',
    );
  }
  if (expected.runId !== undefined && envelope?.provenance?.runId !== expected.runId) {
    return structuredError('run-id-mismatch', expected.runId, envelope?.provenance?.runId, 'Keep the workflow run identity from the triggering event.');
  }
  if (expected.attempt !== undefined && envelope?.provenance?.attempt !== expected.attempt) {
    return structuredError('attempt-mismatch', expected.attempt, envelope?.provenance?.attempt, 'Keep the workflow run attempt paired with its jobs.');
  }
  if (expected.jobId !== undefined && envelope?.provenance?.jobId !== expected.jobId) {
    return structuredError('job-id-mismatch', expected.jobId, envelope?.provenance?.jobId, 'Keep the job identity from the target workflow run.');
  }
  if (expected.htmlUrl !== undefined && envelope?.provenance?.htmlUrl !== expected.htmlUrl) {
    return structuredError('html-url-mismatch', expected.htmlUrl, envelope?.provenance?.htmlUrl, 'Preserve the target run URL as a direct evidence link.');
  }
  return { ok: true };
}

export function validatePostMergeEnvelope(envelope, expected = {}) {
  const required = ['contractVersion', 'checkId', 'owner', 'profile', 'executionHome', 'provenance', 'terminalStatus', 'attempts'];
  for (const field of required) {
    if (envelope?.[field] === undefined) {
      return structuredError('envelope-field-missing', field, 'missing', `Include ${field} in the post-merge evidence envelope.`);
    }
  }
  if (!Array.isArray(envelope.attempts) || envelope.attempts.length === 0) {
    return structuredError('attempts-missing', 'a non-empty attempts array', envelope.attempts, 'Preserve every target workflow attempt.');
  }
  if (!FAILURE_CLASSES.has(envelope.failureClass) && envelope.failureClass !== null) {
    return structuredError('failure-class-invalid', [...FAILURE_CLASSES], envelope.failureClass, 'Use the closed failure class union.');
  }
  return validatePostMergeIdentity(envelope, expected);
}

export function buildPostMergeEnvelope({
  workflowRun,
  job,
  targetSha,
  contractVersion = POST_MERGE_CONTRACT_VERSION,
  monitorSha = null,
  envelopeOverrides = {},
} = {}) {
  const requiredRunFields = [
    ['id', workflowRun?.id],
    ['run_attempt', workflowRun?.run_attempt],
    ['head_sha', workflowRun?.head_sha],
    ['html_url', workflowRun?.html_url],
  ];
  for (const [name, value] of requiredRunFields) {
    if (value === undefined || value === null || value === '') {
      return structuredError(`workflow-run-${name}-missing`, `workflowRun.${name} is present`, value, `Preserve workflow_run.${name} from the event payload.`);
    }
  }
  if (workflowRun.head_sha !== targetSha) {
    return structuredError('target-sha-mismatch', targetSha, workflowRun.head_sha, 'Use workflow_run.head_sha as the target version, not the monitor checkout SHA.');
  }
  if (contractVersion !== POST_MERGE_CONTRACT_VERSION) {
    return structuredError('contract-version-mismatch', POST_MERGE_CONTRACT_VERSION, contractVersion, 'Use the producer-owned contract version for this report.');
  }
  if (!job?.id || !job?.name) {
    return structuredError('job-identity-missing', 'job id and name', job, 'Keep the target workflow job identity in the evidence envelope.');
  }

  const provenance = postMergeProvenance({ workflowRun, targetSha, monitorSha, job });
  provenance.runId = envelopeOverrides.runId ?? provenance.runId;
  provenance.attempt = envelopeOverrides.attempt ?? provenance.attempt;
  provenance.jobId = envelopeOverrides.jobId ?? provenance.jobId;
  provenance.targetSha = envelopeOverrides.targetSha ?? provenance.targetSha;
  const failed = job.conclusion !== 'success';
  const envelope = {
    contractVersion,
    checkId: job.name,
    owner: 'editor-ci',
    profile: 'post-merge',
    executionHome: POST_MERGE_EXECUTION_HOME,
    provenance,
    ...(failed
      ? failureFields('source', 'workflow-job-failure', `job=${job.name}`, 'Inspect the structured firstFailure before changing source.', workflowRun.run_attempt)
      : successFields()),
    attempts: [
      {
        attempt: workflowRun.run_attempt,
        attemptId: `run-${workflowRun.id}-attempt-${workflowRun.run_attempt}`,
        status: failed ? 'failure' : 'pass',
        transient: false,
      },
    ],
    sloClaim: null,
  };
  const validation = validatePostMergeEnvelope(envelope, {
    contractVersion: POST_MERGE_CONTRACT_VERSION,
    targetSha,
    runId: workflowRun.id,
    attempt: workflowRun.run_attempt,
    jobId: job.id,
    htmlUrl: workflowRun.html_url,
  });
  return validation.ok ? { ok: true, envelope } : validation;
}

export function appendPostMergeAttempt(envelope, attempt) {
  const next = structuredClone(envelope);
  next.attempts = [...(Array.isArray(next.attempts) ? next.attempts : []), structuredClone(attempt)];
  return next;
}

export function decidePostMergeRetry(envelope) {
  const eligible = envelope?.failureClass === 'external-transport' && envelope?.attempts?.[0]?.transient === true;
  const maxAttempts = eligible ? 2 : 1;
  const attemptCount = Array.isArray(envelope?.attempts) ? envelope.attempts.length : 0;
  return {
    retry: eligible && attemptCount < maxAttempts,
    maxAttempts,
    reason: eligible ? 'transient external transport evidence' : 'failure class is not retryable',
  };
}

function admissionFailure({ workflowRun, targetSha, monitorSha, failureClass, code, observed, hint }) {
  return { ok: false, envelope: admissionEnvelope({ workflowRun, targetSha, monitorSha, failureClass, code, observed, hint }) };
}

function deliveryFailure(status, code, expected, observed, hint, blocker, requiredEvidence, nextAction, extra = {}) {
  return {
    ok: false,
    status,
    error: structuredError(code, expected, observed, hint).error,
    handoff: {
      blocker,
      owner: 'release owner',
      requiredEvidence,
      nextAction,
    },
    ...extra,
  };
}

function validateDeliveryWorkflowRun(workflowRun, landed) {
  if (!workflowRun || workflowRun.id === undefined || workflowRun.run_attempt === undefined || !workflowRun.html_url) {
    return deliveryFailure(
      'pending',
      'workflow-run-identity-missing',
      'workflow_run id, run_attempt, head_sha, and html_url',
      workflowRun ?? 'missing',
      'Preserve the triggering workflow_run identity before classifying post-merge delivery.',
      'workflow run identity is incomplete',
      ['workflow_run.id', 'workflow_run.run_attempt', 'workflow_run.head_sha', 'workflow_run.html_url'],
      'Re-run the monitor from the completed workflow_run event.',
    );
  }
  if (!landed || workflowRun.head_sha !== landed.landedSha) {
    return deliveryFailure(
      'nonpass',
      'post-merge-target-sha-mismatch',
      landed?.landedSha ?? 'landedSha',
      workflowRun.head_sha ?? 'missing',
      'Use workflow_run.head_sha as the target identity and compare it with the exact landed SHA; never use monitor checkout SHA.',
      'workflow target SHA does not equal landed SHA',
      ['workflow_run.head_sha', 'landedSha'],
      'Collect delivery evidence for the exact workflow_run.head_sha.',
    );
  }
  return null;
}

/**
 * Build the post-merge join envelope. Producer identity and landed delivery
 * remain separate objects so a monitor checkout cannot impersonate either one.
 */
export function buildPostMergeDeliveryEnvelope({
  workflowRun,
  producer,
  landed,
  consumerReports = [],
  monitorSha = null,
  expectedAdmissionGeneration,
} = {}) {
  const workflowIssue = validateDeliveryWorkflowRun(workflowRun, landed);
  if (workflowIssue) return workflowIssue;
  const joined = createDeliveryEnvelope({
    producer,
    landed,
    consumerReports,
    expectedAdmissionGeneration,
  });
  if (!joined.ok) return joined;
  const envelope = {
    contractVersion: POST_MERGE_CONTRACT_VERSION,
    checkId: 'post-merge-delivery',
    owner: 'editor-ci',
    profile: 'post-merge',
    executionHome: POST_MERGE_EXECUTION_HOME,
    provenance: postMergeProvenance({
      workflowRun,
      targetSha: workflowRun.head_sha,
      monitorSha,
    }),
    terminalStatus: 'pass',
    failureClass: null,
    code: null,
    expected: 'exact landed delivery joins the producer release identity',
    observed: 'producer and landed evidence validated',
    hint: 'No recovery action is required.',
    firstFailure: null,
    attempts: [{
      attempt: workflowRun.run_attempt,
      attemptId: `run-${workflowRun.id}-attempt-${workflowRun.run_attempt}`,
      status: 'pass',
      transient: false,
    }],
    sloClaim: null,
    producer: joined.producer,
    landed: joined.landed,
    consumerReports: joined.consumerReports,
  };
  return {ok: true, status: 'pass', envelope};
}

/**
 * Classify a completed post-merge delivery using exact target-SHA and join evidence.
 * Missing evidence remains pending; deterministic mismatches remain nonpass.
 */
export function classifyPostMergeDelivery({
  workflowRun,
  relatedRuns = [],
  producer,
  landed,
  consumerReports = [],
  monitorSha = null,
  expectedAdmissionGeneration,
} = {}) {
  if (producer === undefined || producer === null) {
    return deliveryFailure(
      'pending',
      'producer-identity-missing',
      'producer release identity',
      'missing',
      'Obtain the immutable producer release report before classifying landed delivery.',
      'producer release evidence is missing',
      ['artifactId', 'releaseDigest', 'producerRunId', 'producerAttempt', 'sourceSha', 'recursivePins'],
      'Download or query the producer release report for this workflow run.',
      {classification: 'landed-delivery-pending'},
    );
  }
  const workflowIssue = validateDeliveryWorkflowRun(workflowRun, landed);
  if (workflowIssue) return workflowIssue;
  const duplicate = duplicateRun(workflowRun, Array.isArray(relatedRuns) ? relatedRuns : []);
  if (duplicate) {
    return deliveryFailure(
      'nonpass',
      'duplicate-same-sha-delivery',
      'one current delivery for the target SHA',
      {currentRunId: workflowRun.id, earlierRunId: duplicate.id},
      'Keep the current target-SHA delivery record and do not promote an earlier duplicate run.',
      'duplicate same-SHA delivery',
      [`workflow run ${workflowRun.id}`, `workflow run ${duplicate.id}`],
      'Classify the newest target-SHA run and retain the duplicate as diagnostic evidence.',
      {classification: 'duplicate-same-sha-delivery'},
    );
  }
  if (workflowRun.conclusion !== undefined && workflowRun.conclusion !== 'success') {
    return deliveryFailure(
      'nonpass',
      'post-merge-run-nonpass',
      'success',
      workflowRun.conclusion,
      'A non-success target workflow run cannot establish landed delivery even when some contexts are present.',
      'target post-merge workflow is not successful',
      LANDED_REQUIRED_CONTEXTS.map((context) => `${context} on ${workflowRun.head_sha}`),
      'Resolve the target workflow run and collect a new exact-SHA delivery record.',
      {classification: 'post-merge-run-nonpass'},
    );
  }
  const result = buildPostMergeDeliveryEnvelope({
    workflowRun,
    producer,
    landed,
    consumerReports,
    monitorSha,
    expectedAdmissionGeneration,
  });
  if (!result.ok) {
    return {
      ...result,
      classification: result.error?.code === 'duplicate-same-sha-delivery'
        ? 'duplicate-same-sha-delivery'
        : result.status === 'pending' ? 'landed-delivery-pending' : 'landed-delivery-nonpass',
    };
  }
  return {
    ok: true,
    status: 'pass',
    classification: 'landed-delivery-success',
    envelope: result.envelope,
  };
}

export function classifyPostMergeAdmission({
  workflowRun = { id: 1, run_attempt: 1, head_sha: '', html_url: '' },
  targetSha,
  jobs = [],
  liveRuleset,
  liveEvidence = true,
  requiredContexts = [],
  monitorSha = null,
  workflowAdmission,
  liveAdmissionError,
} = {}) {
  if (!liveEvidence) {
    return admissionFailure({
      workflowRun,
      targetSha,
      monitorSha,
      failureClass: 'external-transport',
      code: 'live-evidence-unavailable',
      observed: 'static fixture only',
      hint: 'Obtain live ruleset or cloud packet evidence before claiming equality.',
    });
  }
  if (liveAdmissionError) {
    return admissionFailure({
      workflowRun,
      targetSha,
      monitorSha,
      failureClass: 'external-transport',
      code: liveAdmissionError.code ?? 'live-ruleset-unavailable',
      observed: liveAdmissionError.observed ?? liveAdmissionError,
      hint: liveAdmissionError.hint ?? 'Provide readable live ruleset list/detail evidence before classifying success.',
    });
  }
  if (!liveRuleset) {
    return admissionFailure({
      workflowRun,
      targetSha,
      monitorSha,
      failureClass: 'external-transport',
      code: 'live-ruleset-unavailable',
      observed: 'ruleset input is unavailable',
      hint: 'Provide readable live ruleset evidence; static fixtures cannot prove current equality.',
    });
  }
  let actualContexts;
  try {
    actualContexts = requiredContextNamesFromRuleset(liveRuleset);
  } catch {
    actualContexts = [];
  }
  if (actualContexts.length === 0) {
    return admissionFailure({
      workflowRun,
      targetSha,
      monitorSha,
      failureClass: 'admission',
      code: 'admission-ruleset-empty',
      observed: liveRuleset,
      hint: 'The selected live ruleset must contain a non-empty required-status-check rule.',
    });
  }
  if (new Set(actualContexts).size !== actualContexts.length) {
    return admissionFailure({
      workflowRun,
      targetSha,
      monitorSha,
      failureClass: 'admission',
      code: 'required-context-shadowed',
      observed: actualContexts,
      hint: 'Reject duplicate live required contexts instead of selecting one shadowed record.',
    });
  }
  if (JSON.stringify([...actualContexts].sort()) !== JSON.stringify([...requiredContexts].sort())) {
    return admissionFailure({
      workflowRun,
      targetSha,
      monitorSha,
      failureClass: 'admission',
      code: 'required-context-drift',
      observed: actualContexts,
      hint: 'Align live required contexts with the producer-owned contract.',
    });
  }
  if (workflowAdmission && workflowAdmission.ok !== true) {
    const error = workflowAdmission.errors?.[0] ?? {};
    return admissionFailure({
      workflowRun,
      targetSha,
      monitorSha,
      failureClass: 'admission',
      code: error.code ?? 'workflow-admission',
      observed: error.observed ?? workflowAdmission,
      hint: error.hint ?? 'The trusted workflow graph, runner capability, or permission policy did not admit.',
    });
  }
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return admissionFailure({
      workflowRun,
      targetSha,
      monitorSha,
      failureClass: 'admission',
      code: 'zero-job',
      observed: 0,
      hint: 'Fetch the target workflow attempt jobs before evaluating terminal status.',
    });
  }
  for (const context of requiredContexts) {
    const matches = jobs.filter((job) => String(job?.id ?? '') === context || job?.name === context);
    if (matches.length === 0) {
      return admissionFailure({
        workflowRun,
        targetSha,
        monitorSha,
        failureClass: 'admission',
        code: 'required-context-job-missing',
        observed: {context, jobs: jobs.map((job) => job?.name ?? job?.id)},
        hint: `The target workflow attempt must contain exactly one job for ${context}.`,
      });
    }
    if (matches.length !== 1) {
      return admissionFailure({
        workflowRun,
        targetSha,
        monitorSha,
        failureClass: 'admission',
        code: 'required-context-job-ambiguous',
        observed: {context, matches: matches.map((job) => ({id: job?.id, name: job?.name}))},
        hint: `The target workflow attempt must not shadow ${context} with multiple jobs.`,
      });
    }
  }
  const observedAttempts = jobs.map((job) => job?.run_attempt).filter((attempt) => attempt !== undefined && attempt !== null);
  if (observedAttempts.length > 0 && observedAttempts.length !== jobs.length) {
    return admissionFailure({
      workflowRun,
      targetSha,
      monitorSha,
      failureClass: 'admission',
      code: 'run-attempt-missing',
      observed: jobs.map((job) => ({id: job?.id, runAttempt: job?.run_attempt})),
      hint: 'Every observed target job must carry the run attempt when attempt evidence is available.',
    });
  }
  const mismatchedJob = jobs.find(
    (job) => (job.run_id !== undefined && job.run_id !== workflowRun.id)
      || (job.run_attempt !== undefined && job.run_attempt !== workflowRun.run_attempt),
  );
  if (mismatchedJob) {
    return admissionFailure({
      workflowRun,
      targetSha,
      monitorSha,
      failureClass: 'admission',
      code: 'run-attempt-mismatch',
      observed: { runId: mismatchedJob.run_id, attempt: mismatchedJob.run_attempt },
      hint: 'Query jobs for the exact workflow run and attempt; do not mix packets.',
    });
  }
  return { ok: true, envelope: { terminalStatus: 'pass', failureClass: null, attempts: jobs, requiredContexts: actualContexts } };
}

function replacementRun(run, relatedRuns) {
  return relatedRuns
    .filter(
      (candidate) =>
        candidate?.id !== run?.id &&
        candidate?.head_sha !== run?.head_sha &&
        sameDeliveryScope(run, candidate) &&
        isNewer(candidate, run),
    )
    .sort((left, right) => (comparableTime(right) ?? 0) - (comparableTime(left) ?? 0))[0] ?? null;
}

function duplicateRun(run, relatedRuns) {
  return (
    relatedRuns
      .filter(
        (candidate) =>
          candidate?.id !== run?.id &&
          candidate?.head_sha === run?.head_sha &&
          sameDeliveryScope(run, candidate) &&
          isOlder(candidate, run),
      )
      .sort((left, right) => (comparableTime(left) ?? 0) - (comparableTime(right) ?? 0))[0] ?? null
  );
}

function findingBase(run) {
  const identity = requireRunIdentity(run);
  return {
    ...identity,
    red: run.conclusion !== 'success',
    actionable: false,
    evidence: [],
  };
}

/**
 * Deterministic policy owner for completed main-push CI observations.
 * `relatedRuns` is restricted by the monitor to the same CI workflow, branch,
 * and push event before it reaches this function.
 */
export function classifyWorkflowRun({ run, relatedRuns = [], jobs = [], logText = '' } = {}) {
  const finding = findingBase(run);
  const related = Array.isArray(relatedRuns) ? relatedRuns : [];

  if (run.conclusion === 'cancelled') {
    const replacement = replacementRun(run, related);
    if (replacement) {
      finding.classification = 'cancellation-superseded-by-newer-run';
      addEvidence(finding.evidence, 'newer-run', `workflow_run=${replacement.id} head_sha=${replacement.head_sha}`);
      return finalizeFinding(finding, run);
    }
    finding.classification = 'genuine-cancellation';
    finding.actionable = true;
    addEvidence(finding.evidence, 'cancelled-without-replacement', 'no newer same-workflow main push was observed');
    return finalizeFinding(finding, run);
  }

  const duplicate = duplicateRun(run, related);
  if (duplicate) {
    finding.classification = 'duplicate-same-sha-delivery';
    addEvidence(finding.evidence, 'same-head-sha', `earlier workflow_run=${duplicate.id}`);
    return finalizeFinding(finding, run);
  }

  if (run.conclusion === 'success') {
    finding.classification = 'success';
    return finalizeFinding(finding, run);
  }

  const derived = deriveFailureEvidence({ jobs, logText });
  finding.evidence = derived.evidence;
  if (derived.externalTransport) {
    finding.classification = 'external-transport-failure';
    finding.actionable = true;
    return finalizeFinding(finding, run);
  }
  if (derived.deterministicEnvironment) {
    finding.classification = 'deterministic-environment-failure';
    finding.actionable = true;
    return finalizeFinding(finding, run);
  }

  finding.classification = 'repository-source-failure';
  finding.actionable = true;
  if (finding.evidence.length === 0) {
    addEvidence(finding.evidence, 'non-success-conclusion', `conclusion=${run.conclusion ?? 'unknown'}`);
  }
  return finalizeFinding(finding, run);
}

export function exitCodeForFinding(finding) {
  return finding?.red === true ? 1 : 0;
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}

function decode(bytes) {
  return new TextDecoder().decode(bytes ?? new Uint8Array());
}

async function githubJsonPage(path, token) {
  const requestUrl = path.startsWith('http://') || path.startsWith('https://')
    ? path
    : `https://api.github.com/${path}`;
  const response = await fetch(requestUrl, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}`);
  const link = response.headers.get('link') ?? '';
  const next = link.split(',').map((entry) => entry.trim()).find((entry) => entry.endsWith('rel="next"'));
  return {
    value: await response.json(),
    next: next ? next.slice(1, next.indexOf('>')) : null,
  };
}

async function githubJson(path, token) {
  return (await githubJsonPage(path, token)).value;
}

async function githubJsonPages(path, token) {
  const pages = [];
  let next = path;
  while (next) {
    const page = await githubJsonPage(next, token);
    pages.push(page.value);
    next = page.next;
  }
  return pages;
}

function failedLogFromGh(run, repository, token) {
  const command = Bun.spawnSync(['gh', 'run', 'view', String(run.id), '--repo', repository, '--log-failed'], {
    env: { ...process.env, GH_TOKEN: token },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (command.exitCode !== 0) return '';
  return decode(command.stdout).slice(0, MAX_LOG_LENGTH);
}

function writeSummary(finding) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const lines = [
    '## Post-merge CI monitor',
    '',
    `- classification: \`${finding.classification}\``,
    `- red: \`${finding.red}\``,
    `- head_sha: \`${finding.head_sha}\``,
    `- workflow run: ${finding.html_url}`,
  ];
  if (finding.evidence.length > 0) {
    lines.push('', 'Evidence:');
    for (const item of finding.evidence) lines.push(`- \`${item.code}\`: ${item.detail}`);
  }
  appendFileSync(summaryPath, `${lines.join('\n')}\n`);
}

function readDeliveryManifest(path) {
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return {__readError: error.message ?? String(error)};
  }
}

function deliveryInputFromWorkflow({workflowRun, jobs, producer, remoteMainSha, ancestor}) {
  const contexts = LANDED_REQUIRED_CONTEXTS
    .map((context) => {
      const matches = jobs.filter((candidate) => String(candidate?.id ?? '') === context || candidate?.name === context);
      if (matches.length !== 1) return null;
      const job = matches[0];
      return {
        context,
        sha: job.head_sha ?? null,
        conclusion: job.conclusion ?? null,
        provenance: {kind: 'cloud', timingDomain: 'workflow-execution'},
        source: 'required-context',
      };
    })
    .filter(Boolean);
  return {
    producer,
    landed: {
      landedSha: workflowRun.head_sha,
      remoteMain: remoteMainSha
        ? {
            sha: remoteMainSha,
            ancestorSha: workflowRun.head_sha,
            ancestor: ancestor === 'true',
            method: 'git-merge-base-is-ancestor',
            source: 'remote-main',
            repository: 'origin',
          }
        : null,
      contexts,
    },
  };
}

function deliveryFinding(result, workflowRun) {
  const evidence = result.ok
    ? [{code: 'landed-delivery-validated', detail: 'producer identity and exact landed delivery joined'}]
    : [{code: result.error?.code ?? 'landed-delivery-unclassified', detail: result.error?.hint ?? 'landed delivery did not pass'}];
  return {
    classification: result.classification ?? (result.ok ? 'landed-delivery-success' : 'landed-delivery-nonpass'),
    red: !result.ok,
    actionable: !result.ok,
    evidence,
    head_sha: workflowRun.head_sha,
    html_url: workflowRun.html_url,
    delivery: result,
  };
}

function admissionFinding(result, workflowRun) {
  const error = result.envelope?.firstFailure ?? {};
  return {
    classification: 'post-merge-admission-failure',
    red: true,
    actionable: true,
    failureClass: result.envelope?.failureClass ?? 'admission',
    terminalStatus: 'failure',
    code: error.code ?? 'post-merge-admission-failure',
    evidence: [{
      code: error.code ?? 'post-merge-admission-failure',
      detail: error.hint ?? 'post-merge success was blocked by live policy admission',
    }],
    head_sha: workflowRun.head_sha,
    html_url: workflowRun.html_url,
    admission: result,
  };
}

async function main() {
  const token = nonEmptyString(process.env.GITHUB_TOKEN);
  const repository = nonEmptyString(process.env.GITHUB_REPOSITORY);
  const reportPath = optionValue(process.argv.slice(2), '--report');
  let event = null;
  try {
    event = JSON.parse(process.env.WORKFLOW_RUN_EVENT ?? 'null');
  } catch {
    event = null;
  }
  if (!token || !repository || !event) {
    const envelope = admissionEnvelope({
      workflowRun: { id: 0, run_attempt: 1, head_sha: 'unavailable', html_url: 'unavailable://workflow-run' },
      targetSha: 'unavailable',
      failureClass: 'admission',
      code: 'admission-input-missing',
      observed: { token: Boolean(token), repository: Boolean(repository), workflowRunEvent: Boolean(event) },
      hint: 'Run the monitor from workflow_run with its trusted event and GitHub API credentials.',
    });
    if (reportPath) writeFileSync(reportPath, `${JSON.stringify({ contractVersion: POST_MERGE_CONTRACT_VERSION, ...envelope }, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
    process.exitCode = 1;
    return;
  }

  const workflowRun = event;
  let producerContract;
  try {
    producerContract = JSON.parse(readFileSync(new URL('./editor-ci-contract.json', import.meta.url), 'utf8'));
  } catch (error) {
    const envelope = admissionEnvelope({
      workflowRun,
      targetSha: workflowRun.head_sha,
      failureClass: 'admission',
      code: 'producer-contract-unavailable',
      observed: error.message ?? String(error),
      hint: 'Load the producer-owned contract from the trusted monitor checkout before classifying success.',
    });
    if (reportPath) writeFileSync(reportPath, `${JSON.stringify({ contractVersion: POST_MERGE_CONTRACT_VERSION, ...envelope }, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
    process.exitCode = 1;
    return;
  }
  let relatedRuns = [];
  let jobs = [];
  let externalTransportUnavailable = false;
  try {
    const runs = await githubJson(
      `repos/${repository}/actions/workflows/${workflowRun.workflow_id}/runs?branch=${encodeURIComponent(workflowRun.head_branch)}&event=push&per_page=100`,
      token,
    );
    relatedRuns = (runs.workflow_runs ?? []).filter(
      (candidate) => candidate.id !== workflowRun.id && candidate.head_branch === workflowRun.head_branch,
    );
  } catch (error) {
    externalTransportUnavailable = true;
    console.error(`Could not read related workflow runs: ${error.message}`);
  }
  try {
    const jobPages = await githubJsonPages(`repos/${repository}/actions/runs/${workflowRun.id}/jobs?per_page=100`, token);
    jobs = jobPages.flatMap((page) => page.jobs ?? []);
  } catch (error) {
    externalTransportUnavailable = true;
    console.error(`Could not read workflow jobs: ${error.message}`);
  }

  let liveRuleset = null;
  let workflowAdmission = null;
  let liveAdmissionError = null;
  const liveDiscovery = await discoverLiveRuleset({
    readRepository: () => githubJson(`repos/${repository}`, token),
    readRulesets: () => githubJsonPages(`repos/${repository}/rulesets?per_page=100`, token),
    readDetail: (id) => githubJson(`repos/${repository}/rulesets/${id}`, token),
  });
  if (!liveDiscovery.ok) {
    liveAdmissionError = liveDiscovery.errors?.[0] ?? {
      code: 'live-ruleset-unavailable',
      hint: 'Read the active default-branch ruleset before classifying success.',
    };
  } else {
    try {
      const selectedContexts = requiredContextNamesFromRuleset(liveDiscovery.ruleset);
      liveRuleset = {...liveDiscovery.ruleset, requiredContexts: selectedContexts};
      workflowAdmission = validateRuntimeProjection(
        producerContract,
        resolve('.github/workflows'),
        liveDiscovery.ruleset,
        {includePortfolio: false},
      );
    } catch (error) {
      liveAdmissionError = {
        code: 'admission-ruleset-empty',
        observed: error.message ?? String(error),
        hint: 'The selected live ruleset must contain a readable required-status-check rule.',
      };
    }
  }

  let logText = '';
  if (workflowRun.conclusion !== 'success') {
    try {
      logText = failedLogFromGh(workflowRun, repository, token);
    } catch (error) {
      console.error(`Could not read failed job logs: ${error.message}`);
    }
  }

  const admission = classifyPostMergeAdmission({
    workflowRun,
    targetSha: workflowRun.head_sha,
    jobs,
    liveRuleset,
    liveEvidence: true,
    requiredContexts: producerContract.requiredContexts.map((entry) => entry.context),
    monitorSha: nonEmptyString(process.env.GITHUB_SHA),
    workflowAdmission,
    liveAdmissionError,
  });
  const finding = admission.ok
    ? classifyWorkflowRun({ run: workflowRun, relatedRuns, jobs, logText })
    : admissionFinding(admission, workflowRun);
  const producerManifest = readDeliveryManifest(process.env.PREREQUISITE_RELEASE_MANIFEST);
  const deliveryMode = Boolean(process.env.PREREQUISITE_RELEASE_MANIFEST);
  let finalFinding = finding;
  if (deliveryMode && admission.ok) {
    const deliveryInput = deliveryInputFromWorkflow({
      workflowRun,
      jobs,
      producer: producerManifest?.__readError ? null : producerManifest,
      remoteMainSha: nonEmptyString(process.env.REMOTE_MAIN_SHA),
      ancestor: process.env.LANDED_ANCESTOR,
    });
    finalFinding = deliveryFinding(classifyPostMergeDelivery({
      workflowRun,
      relatedRuns,
      ...deliveryInput,
      monitorSha: nonEmptyString(process.env.GITHUB_SHA),
    }), workflowRun);
    if (producerManifest?.__readError) {
      finalFinding.evidence.push({code: 'producer-manifest-unreadable', detail: 'the downloaded producer manifest could not be parsed'});
    }
  }
  if (externalTransportUnavailable) {
    finalFinding.classification = 'external-transport-failure';
    finalFinding.failureClass = 'external-transport';
    finalFinding.red = true;
    finalFinding.actionable = true;
    addEvidence(finalFinding.evidence, 'github-api-unavailable', 'live GitHub workflow evidence could not be read');
    if (!deliveryMode) finalizeFinding(finalFinding, workflowRun);
  }
  writeSummary(finalFinding);
  if (reportPath) {
    writeFileSync(reportPath, `${JSON.stringify({ contractVersion: POST_MERGE_CONTRACT_VERSION, ...finalFinding }, null, 2)}\n`);
  }
  console.log(JSON.stringify(finalFinding));
  process.exitCode = exitCodeForFinding(finalFinding);
  if (finalFinding.red) {
    console.error(`Post-merge CI remains red: ${finalFinding.classification} ${finalFinding.html_url}`);
  }
}

if (import.meta.main) await main();
