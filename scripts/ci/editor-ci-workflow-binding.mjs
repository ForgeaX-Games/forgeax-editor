#!/usr/bin/env node
// Bind the producer-owned contract to the trusted static workflow graph.
// The workflow graph and runner parser remain owned by ci-baseline; this file
// only validates the contract-facing projection and its admission boundaries.

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { parse as parseYaml } from 'yaml';
import { buildWorkflowGraph, extractRequiredContexts } from './ci-baseline.mjs';

const REQUIRED_CONTEXTS = Object.freeze(['b2-self-boot', 'typecheck', 'submodule-pin', 'smoke-play']);
const CAPACITY_BY_CHECK = Object.freeze({
  'b2-self-boot': 'standard',
  typecheck: 'standard',
  'submodule-pin': 'standard',
  'smoke-play': 'heavy',
});

function issue(code, expected, observed, hint) {
  return { code, expected, observed, hint };
}

function failure(error) {
  return { ok: false, errors: [error], bindings: [] };
}

function checksById(contract) {
  return new Map((contract.checks ?? []).map((check) => [check.checkId, check]));
}

function allJobs(graph) {
  return (graph.workflows ?? []).flatMap((workflow) => workflow.jobs ?? []);
}

function validateRequiredContextNames(contract) {
  const entries = contract.requiredContexts ?? [];
  const names = entries.map((entry) => entry.context);
  if (names.length !== REQUIRED_CONTEXTS.length ||
      REQUIRED_CONTEXTS.some((context) => !names.includes(context)) ||
      names.some((context) => !REQUIRED_CONTEXTS.includes(context))) {
    return issue(
      'required-context-drift',
      REQUIRED_CONTEXTS,
      names,
      'Keep the four migration-era required context names stable.',
    );
  }
  return null;
}

export function validateWorkflowBinding(contract, graph, { docOnly = false } = {}) {
  if (!contract || typeof contract !== 'object' || !Array.isArray(contract.checks)) {
    return failure(issue('contract-invalid', 'a producer-owned contract object', contract, 'Load the contract before binding workflow jobs.'));
  }
  if (!graph || typeof graph !== 'object' || allJobs(graph).length === 0) {
    return failure(issue('zero-job', 'at least one workflow job', allJobs(graph).length, 'Provide the trusted workflow graph before validating bindings.'));
  }
  if (docOnly && graph.docOnlyEvidence !== true) {
    return failure(issue(
      'doc-only-evidence-insufficient',
      'explicit doc-only evidence',
      graph.docOnlyEvidence ?? false,
      'Do not infer doc-only status from an incomplete workflow graph.',
    ));
  }

  const contextNameIssue = validateRequiredContextNames(contract);
  if (contextNameIssue) return failure(contextNameIssue);

  const checks = checksById(contract);
  const graphContexts = graph.requiredContexts ?? [];
  const jobs = allJobs(graph);
  const bindings = [];
  const boundJobs = new Set();

  for (const required of contract.requiredContexts) {
    const binding = bindContext(required, graphContexts, jobs, checks, boundJobs);
    if (!binding.ok) return failure(binding.error);
    bindings.push(binding.value);
  }

  return { ok: true, errors: [], bindings };
}

function bindContext(required, graphContexts, jobs, checks, boundJobs) {
  const record = graphContexts.find((candidate) => candidate.context === required.context);
  if (!record) {
    return { ok: false, error: issue('required-context-missing', required.context, graphContexts.map((candidate) => candidate.context), `Bind required context ${required.context} to one workflow job.`) };
  }
  const matches = record.matches ?? jobs
    .filter((job) => job.id === required.context || job.name === required.context)
    .map((job) => ({ workflow: record.workflow ?? '<workflow>', jobId: job.id, jobName: job.name }));
  if (matches.length === 0) {
    return { ok: false, error: issue('required-context-missing', `one workflow job for ${required.context}`, matches, `Bind ${required.context} to exactly one workflow job.`) };
  }
  if (matches.length !== 1) {
    return { ok: false, error: issue('required-context-ambiguous', `one workflow job for ${required.context}`, matches, `Remove extra workflow jobs bound to ${required.context}.`) };
  }

  const match = matches[0];
  const job = jobs.find((candidate) => candidate.id === match.jobId && candidate.name === match.jobName) ??
    jobs.find((candidate) => candidate.id === match.jobId || candidate.name === match.jobName);
  if (!job) return { ok: false, error: issue('required-context-missing', match, jobs, `Make workflow job ${required.context} addressable from the trusted graph.`) };
  const check = checks.get(required.checkId);
  if (!check) return { ok: false, error: issue('binding-check-unknown', [...checks.keys()], required.checkId, `Declare ${required.checkId} in the producer contract before binding it.`) };
  if (boundJobs.has(`${match.workflow}:${match.jobId}`)) {
    return { ok: false, error: issue('binding-one-to-many', 'one contract identity per workflow job', match, 'Do not bind one workflow job to multiple contract identities.') };
  }
  boundJobs.add(`${match.workflow}:${match.jobId}`);

  const expectedPool = CAPACITY_BY_CHECK[required.checkId];
  if (job.runner?.kind === 'self-hosted' && job.runner.pool !== expectedPool) {
    return { ok: false, error: issue('runner-capacity-drift', expectedPool, job.runner.pool ?? null, `Keep ${required.checkId} on the ${expectedPool} self-hosted capacity pool.`) };
  }
  return {
    ok: true,
    value: {
      checkId: required.checkId,
      context: required.context,
      workflow: match.workflow,
      jobId: match.jobId,
      jobName: match.jobName,
      owner: check.owner,
      executionHome: structuredClone(check.executionHome),
    },
  };
}

function argumentValue(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function workflowSources(workflowsDir) {
  return readdirSync(workflowsDir)
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()
    .map((file) => ({ file, text: readFileSync(resolve(workflowsDir, file), 'utf8') }));
}

function main(argv = process.argv.slice(2)) {
  const workflowsDir = resolve(argumentValue(argv, '--workflows-dir', '.github/workflows'));
  const rulesetPath = resolve(argumentValue(argv, '--ruleset-file', 'scripts/ci/fixtures/ruleset.json'));
  const contract = JSON.parse(readFileSync(resolve('ci/editor-ci-contract.json'), 'utf8'));
  const ruleset = JSON.parse(readFileSync(rulesetPath, 'utf8'));
  let result;
  try {
    const graph = buildWorkflowGraph(workflowSources(workflowsDir), extractRequiredContexts(ruleset));
    result = validateWorkflowBinding(contract, graph);
  } catch (error) {
    result = failure(issue(
      error.code ?? 'workflow-admission',
      'trusted workflow graph can be parsed',
      error.message ?? String(error),
      'Fix the trusted workflow or ruleset input before binding contract identities.',
    ));
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.main) main();
