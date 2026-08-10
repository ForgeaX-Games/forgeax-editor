#!/usr/bin/env node

import { appendFileSync, writeFileSync } from 'node:fs';
import { CONTRACT_SCHEMA_VERSION } from './editor-ci-contract.mjs';

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

export function classifyPostMergeAdmission({
  workflowRun = { id: 1, run_attempt: 1, head_sha: '', html_url: '' },
  targetSha,
  jobs = [],
  liveRuleset,
  liveEvidence = true,
  requiredContexts = [],
  monitorSha = null,
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
  const actualContexts = Array.isArray(liveRuleset.requiredContexts) ? liveRuleset.requiredContexts : [];
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
  return { ok: true, envelope: { terminalStatus: 'pass', failureClass: null, attempts: jobs } };
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

async function githubJson(path, token) {
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}`);
  return response.json();
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
    const jobPage = await githubJson(`repos/${repository}/actions/runs/${workflowRun.id}/jobs?per_page=100`, token);
    jobs = jobPage.jobs ?? [];
  } catch (error) {
    externalTransportUnavailable = true;
    console.error(`Could not read workflow jobs: ${error.message}`);
  }

  let logText = '';
  if (workflowRun.conclusion !== 'success') {
    try {
      logText = failedLogFromGh(workflowRun, repository, token);
    } catch (error) {
      console.error(`Could not read failed job logs: ${error.message}`);
    }
  }

  const finding = classifyWorkflowRun({ run: workflowRun, relatedRuns, jobs, logText });
  if (externalTransportUnavailable) {
    finding.classification = 'external-transport-failure';
    finding.failureClass = 'external-transport';
    finding.red = true;
    finding.actionable = true;
    addEvidence(finding.evidence, 'github-api-unavailable', 'live GitHub workflow evidence could not be read');
    finalizeFinding(finding, workflowRun);
  }
  writeSummary(finding);
  if (reportPath) {
    writeFileSync(reportPath, `${JSON.stringify({ contractVersion: POST_MERGE_CONTRACT_VERSION, ...finding }, null, 2)}\n`);
  }
  console.log(JSON.stringify(finding));
  process.exitCode = exitCodeForFinding(finding);
  if (finding.red) {
    console.error(`Post-merge CI remains red: ${finding.classification} ${finding.html_url}`);
  }
}

if (import.meta.main) await main();
