import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

export const CONTRACT_SCHEMA_VERSION = 'forgeax-editor-ci-contract/v1';
export const EXECUTION_HOMES = [
  'local-fast',
  'local-full',
  'PR',
  'main',
  'nightly/scheduled',
  'post-merge',
];
export const REQUIRED_CONTEXTS = ['b2-self-boot', 'typecheck', 'submodule-pin', 'smoke-play'];
export const FAILURE_CLASSES = ['admission', 'environment', 'source', 'external-transport'];

function issue(code, expected, observed, hint) {
  return { code, expected, observed, hint };
}

function result(errors = []) {
  return { ok: errors.length === 0, errors };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function firstIssueForField(value, path, expected) {
  const missing = value === undefined;
  const validType = expected === 'object'
    ? isObject(value)
    : expected === 'array'
      ? Array.isArray(value)
      : typeof value === expected;
  const invalid = !missing && !validType;
  if (missing) {
    return issue(
      'schema-field-missing',
      `${path} is present`,
      'missing',
      `Add the required ${path} field to the contract.`,
    );
  }
  if (invalid) {
    return issue(
      'schema-field-type',
      `${path} is a ${expected}`,
      Array.isArray(value) ? 'array' : typeof value,
      `Set ${path} to a ${expected} value.`,
    );
  }
  return null;
}

function validateCheckSchema(check, index) {
  if (!isObject(check)) {
    return issue(`schema-check-${index}-type`, 'an object', typeof check, `Make checks[${index}] an object.`);
  }
  for (const field of ['checkId', 'owner', 'command', 'executionHome', 'failureClasses']) {
    const expected = field === 'executionHome' ? 'object' : field === 'failureClasses' ? 'array' : 'string';
    const fieldIssue = firstIssueForField(check[field], `checks[${index}].${field}`, expected);
    if (fieldIssue) return fieldIssue;
  }
  if (!check.failureClasses.every((value) => typeof value === 'string')) {
    return issue(
      'schema-field-type',
      `checks[${index}].failureClasses contains strings`,
      check.failureClasses,
      'Use failure class strings in each check declaration.',
    );
  }
  return null;
}

function validateProfilesSchema(profiles) {
  for (const [index, profile] of Object.entries(profiles)) {
    if (!Array.isArray(profile) || !profile.every((checkId) => typeof checkId === 'string')) {
      return issue(
        'schema-field-type',
        `profiles.${index} is an array of strings`,
        profile,
        `Use checkId strings in profiles.${index}.`,
      );
    }
  }
  return null;
}

function validateRequiredContextsSchema(requiredContexts) {
  for (const [index, context] of requiredContexts.entries()) {
    if (!isObject(context)) {
      return issue(`schema-required-context-${index}-type`, 'an object', typeof context, `Make requiredContexts[${index}] an object.`);
    }
    for (const field of ['context', 'checkId']) {
      const fieldIssue = firstIssueForField(context[field], `requiredContexts[${index}].${field}`, 'string');
      if (fieldIssue) return fieldIssue;
    }
  }
  return null;
}

function validateQualitySchema(packageQuality) {
  for (const [field, expected] of [['ownershipClasses', 'array'], ['coveragePolicy', 'object']]) {
    const fieldIssue = firstIssueForField(packageQuality[field], `packageQuality.${field}`, expected);
    if (fieldIssue) return fieldIssue;
  }
  const coverage = packageQuality.coveragePolicy;
  for (const [field, expected] of [['requiredDimensions', 'array'], ['range', 'array'], ['source', 'string']]) {
    const fieldIssue = firstIssueForField(coverage[field], `packageQuality.coveragePolicy.${field}`, expected);
    if (fieldIssue) return fieldIssue;
  }
  return null;
}

function validateFailurePolicySchema(failurePolicy) {
  for (const [field, expected] of [
    ['failureClasses', 'array'],
    ['retryableClass', 'string'],
    ['requiresTransientEvidence', 'boolean'],
    ['maxAutomaticRetries', 'number'],
  ]) {
    const fieldIssue = firstIssueForField(failurePolicy[field], `failurePolicy.${field}`, expected);
    if (fieldIssue) return fieldIssue;
  }
  if (failurePolicy.sloClaim === undefined) {
    return issue('schema-field-missing', 'failurePolicy.sloClaim is present', 'missing', 'Declare sloClaim as null when this contract does not produce SLO evidence.');
  }
  return null;
}

function validateSchema(contract) {
  if (!isObject(contract)) {
    return issue('schema-root-type', 'an object', Array.isArray(contract) ? 'array' : typeof contract, 'Load a JSON object as the contract.');
  }
  for (const [path, expected] of [
    ['$schema', 'string'],
    ['version', 'string'],
    ['checks', 'array'],
    ['profiles', 'object'],
    ['requiredContexts', 'array'],
    ['packageQuality', 'object'],
    ['provenance', 'object'],
    ['failurePolicy', 'object'],
  ]) {
    const fieldIssue = firstIssueForField(contract[path], path, expected);
    if (fieldIssue) return fieldIssue;
  }
  if (contract.$schema !== CONTRACT_SCHEMA_VERSION || contract.version !== CONTRACT_SCHEMA_VERSION) {
    return issue(
      'schema-version-invalid',
      CONTRACT_SCHEMA_VERSION,
      { $schema: contract.$schema, version: contract.version },
      'Use the supported producer-owned contract schema version.',
    );
  }
  if (contract.checks.length === 0) {
    return issue('zero-job', 'at least one check', 0, 'Declare at least one executable contract check.');
  }
  for (const [index, check] of contract.checks.entries()) {
    const checkIssue = validateCheckSchema(check, index);
    if (checkIssue) return checkIssue;
  }
  for (const schemaIssue of [
    validateProfilesSchema(contract.profiles),
    validateRequiredContextsSchema(contract.requiredContexts),
    validateQualitySchema(contract.packageQuality),
    validateFailurePolicySchema(contract.failurePolicy),
  ]) {
    if (schemaIssue) return schemaIssue;
  }
  return null;
}

function validateIdentity(contract) {
  const ids = new Set();
  for (const check of contract.checks) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(check.checkId)) {
      return issue('identity-format-invalid', 'lower-kebab-case checkId', check.checkId, 'Rename the checkId to lower-kebab-case and keep it stable across homes.');
    }
    if (ids.has(check.checkId)) {
      return issue('identity-duplicate', 'one checkId per contract check', check.checkId, 'Remove the duplicate check declaration instead of creating a second roster.');
    }
    ids.add(check.checkId);
    const homes = Object.keys(check.executionHome);
    const unknownHome = homes.find((home) => !EXECUTION_HOMES.includes(home));
    if (unknownHome) {
      return issue('identity-home-invalid', EXECUTION_HOMES.join(', '), unknownHome, 'Use one of the six supported execution homes.');
    }
    const missingHome = EXECUTION_HOMES.find((home) => !(home in check.executionHome));
    if (missingHome) {
      return issue('identity-home-missing', EXECUTION_HOMES, missingHome, 'Declare true or false for every execution home.');
    }
    const invalidHomeValue = EXECUTION_HOMES.find((home) => typeof check.executionHome[home] !== 'boolean');
    if (invalidHomeValue) {
      return issue('identity-home-type-invalid', 'boolean home applicability', check.executionHome[invalidHomeValue], `Set executionHome.${invalidHomeValue} to true or false.`);
    }
    if (check.failureClasses.some((failureClass) => !FAILURE_CLASSES.includes(failureClass))) {
      return issue('identity-failure-class-invalid', FAILURE_CLASSES, check.failureClasses, 'Use the closed failure class union.');
    }
  }
  for (const home of EXECUTION_HOMES) {
    if (!Array.isArray(contract.profiles[home])) {
      return issue('profile-home-missing', EXECUTION_HOMES, home, 'Declare every execution home profile explicitly.');
    }
    const unknownCheck = contract.profiles[home].find((checkId) => !ids.has(checkId));
    if (unknownCheck) {
      return issue('profile-check-unknown', [...ids].join(', '), unknownCheck, `Remove ${unknownCheck} or add its contract check before using it in a profile.`);
    }
    const profileChecks = new Set(contract.profiles[home]);
    const driftedCheck = contract.checks.find(
      (check) => check.executionHome[home] !== profileChecks.has(check.checkId),
    );
    if (driftedCheck) {
      return issue(
        'profile-home-drift',
        `profiles.${home} matches executionHome.${home}`,
        { checkId: driftedCheck.checkId, executionHome: driftedCheck.executionHome[home], inProfile: profileChecks.has(driftedCheck.checkId) },
        `Keep ${driftedCheck.checkId} in profiles.${home} exactly when executionHome.${home} is true.`,
      );
    }
  }
  const fast = new Set(contract.profiles['local-fast']);
  const full = new Set(contract.profiles['local-full']);
  if (![...fast].every((checkId) => full.has(checkId))) {
    return issue('profile-fast-not-subset', [...full].join(', '), [...fast].filter((checkId) => !full.has(checkId)).join(', '), 'Keep every local-fast check inside local-full.');
  }
  if (fast.size >= full.size) {
    return issue('profile-fast-not-strict', 'local-fast has fewer checks than local-full', fast.size, 'Keep local-fast as a strict risk subset of local-full.');
  }
  const contextCounts = new Map();
  for (const entry of contract.requiredContexts) {
    contextCounts.set(entry.context, (contextCounts.get(entry.context) ?? 0) + 1);
    if (!ids.has(entry.checkId)) {
      return issue('required-context-check-unknown', [...ids].join(', '), entry.checkId, 'Map each required context to one existing checkId.');
    }
  }
  for (const context of REQUIRED_CONTEXTS) {
    const count = contextCounts.get(context) ?? 0;
    if (count === 0) return issue('required-context-missing', 'one mapping for each existing required context', context, `Restore the ${context} mapping without renaming the external context.`);
    if (count > 1) return issue('required-context-duplicate', 'one mapping for each existing required context', context, `Remove duplicate mappings for ${context}.`);
  }
  const unknownContext = [...contextCounts.keys()].find((context) => !REQUIRED_CONTEXTS.includes(context));
  if (unknownContext) return issue('required-context-invalid', REQUIRED_CONTEXTS, unknownContext, 'Keep the migration-era required context set stable.');
  const prChecks = new Set(contract.profiles.PR);
  const nonPrContext = contract.requiredContexts.find((entry) => !prChecks.has(entry.checkId));
  if (nonPrContext) {
    return issue(
      'required-context-home-drift',
      'required contexts map only PR execution-home checks',
      nonPrContext,
      `Remove ${nonPrContext.checkId} from required contexts or enable its PR execution home.`,
    );
  }
  const requiredCheckIds = new Set(contract.requiredContexts.map((entry) => entry.checkId));
  const missingPrContext = [...prChecks].find((checkId) => !requiredCheckIds.has(checkId));
  if (missingPrContext) {
    return issue(
      'required-context-check-missing',
      'one required context mapping for every PR execution-home check',
      missingPrContext,
      `Map ${missingPrContext} to its stable required context.`,
    );
  }
  return null;
}

function validatePolicy(contract) {
  if (!contract.packageQuality.ownershipClasses.every((value) => typeof value === 'string')) {
    return issue('package-quality-ownership-invalid', 'string ownership classes', contract.packageQuality.ownershipClasses, 'Declare ownership classes as strings.');
  }
  const dimensions = contract.packageQuality.coveragePolicy.requiredDimensions;
  if (dimensions.length !== 2 || !dimensions.includes('lines') || !dimensions.includes('functions')) {
    return issue('package-quality-dimensions-invalid', ['lines', 'functions'], dimensions, 'Keep independent lines and functions coverage dimensions.');
  }
  if (contract.packageQuality.coveragePolicy.range.length !== 2 || contract.packageQuality.coveragePolicy.range.some((value) => typeof value !== 'number')) {
    return issue('package-quality-range-invalid', [0, 100], contract.packageQuality.coveragePolicy.range, 'Declare a numeric 0-100 coverage range.');
  }
  if (!FAILURE_CLASSES.every((failureClass) => contract.failurePolicy.failureClasses.includes(failureClass))) {
    return issue('failure-policy-class-missing', FAILURE_CLASSES, contract.failurePolicy.failureClasses, 'Declare all four machine-readable failure classes.');
  }
  if (contract.failurePolicy.retryableClass !== 'external-transport' || contract.failurePolicy.maxAutomaticRetries !== 1 || contract.failurePolicy.requiresTransientEvidence !== true) {
    return issue('failure-policy-retry-invalid', { retryableClass: 'external-transport', maxAutomaticRetries: 1, requiresTransientEvidence: true }, contract.failurePolicy, 'Only transient external transport may retry once.');
  }
  return null;
}

export function validateContract(contract) {
  const schemaIssue = validateSchema(contract);
  if (schemaIssue) return result([schemaIssue]);
  const identityIssue = validateIdentity(contract);
  if (identityIssue) return result([identityIssue]);
  const policyIssue = validatePolicy(contract);
  if (policyIssue) return result([policyIssue]);
  return result();
}

export function projectContract(contract) {
  const checks = contract.checks.map(({ checkId, owner, executionHome }) => ({
    checkId,
    owner,
    executionHome: structuredClone(executionHome),
  }));
  return {
    checks,
    roster: checks,
    profiles: structuredClone(contract.profiles),
    requiredContexts: structuredClone(contract.requiredContexts),
    resultEnvelope: {
      failureClass: 'admission',
      firstFailure: {
        code: 'projection-drift',
        expected: 'contract projection matches producer SSOT',
        observed: 'static candidate projection',
        hint: 'Regenerate the projection from scripts/ci/editor-ci-contract.json.',
      },
    },
  };
}

export function validateProjection(contract, projection) {
  const contractResult = validateContract(contract);
  if (!contractResult.ok) return contractResult;
  if (!isObject(projection) || !Array.isArray(projection.roster) || projection.roster.length === 0) {
    return result([issue('zero-job', 'a non-empty projected roster', projection?.roster?.length ?? 'missing', 'Restore at least one projected job from the contract.')] );
  }
  const expected = projectContract(contract);
  if (JSON.stringify(projection) !== JSON.stringify(expected)) {
    return result([issue('projection-drift', 'projection equals the producer contract', projection, 'Regenerate the projection from the single contract SSOT and retain firstFailure evidence.')]);
  }
  return result();
}

function workflowFiles(workflowsDir) {
  return readdirSync(workflowsDir)
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()
    .map((file) => resolve(workflowsDir, file));
}

function workflowJobs(workflowsDir) {
  return workflowFiles(workflowsDir).flatMap((file) => {
    const document = parseYaml(readFileSync(file, 'utf8'));
    return Object.entries(document?.jobs ?? {}).map(([id, job]) => ({
      workflow: file,
      id,
      name: typeof job?.name === 'string' ? job.name : id,
    }));
  });
}

function rulesetContexts(ruleset) {
  const requiredRule = (ruleset?.rules ?? []).find((rule) => rule?.type === 'required_status_checks');
  return (requiredRule?.parameters?.required_status_checks ?? []).map((record) => record?.context ?? record?.name).filter(Boolean);
}

function cliIssue(code, expected, observed, hint) {
  return result([issue(code, expected, observed, hint)]);
}

export function validateRuntimeProjection(contract, workflowsDir, ruleset) {
  const contractResult = validateContract(contract);
  if (!contractResult.ok) return contractResult;
  const liveContexts = rulesetContexts(ruleset);
  if (liveContexts.length === 0) return cliIssue('admission-ruleset-empty', REQUIRED_CONTEXTS, liveContexts, 'Provide a readable required-status-check ruleset input.');
  const expectedContexts = contract.requiredContexts.map((entry) => entry.context).sort();
  if (JSON.stringify(liveContexts.slice().sort()) !== JSON.stringify(expectedContexts)) {
    return cliIssue('projection-drift', expectedContexts, liveContexts, 'Align the ruleset required contexts with the contract without renaming them.');
  }
  const jobs = workflowJobs(workflowsDir);
  for (const context of contract.requiredContexts) {
    const matches = jobs.filter((job) => job.id === context.context || job.name === context.context);
    if (matches.length !== 1) return cliIssue('projection-drift', `one workflow job for ${context.context}`, matches.length, `Bind ${context.context} to exactly one workflow job in the trusted workflow directory.`);
  }
  return result();
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}

export function runCli(args = process.argv.slice(2)) {
  const contractPath = resolve('scripts/ci/editor-ci-contract.json');
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  const contractResult = validateContract(contract);
  if (!contractResult.ok) return contractResult;
  if (args.includes('--live-ruleset')) {
    return cliIssue('admission-live-ruleset-unavailable', 'readable live ruleset evidence', 'live API not requested in M1', 'Run the deterministic fixture projection or provide live ruleset evidence in the later milestone.');
  }
  const workflowsDir = optionValue(args, '--workflows-dir');
  const rulesetPath = optionValue(args, '--ruleset-file');
  if (!workflowsDir || !rulesetPath) return cliIssue('admission-input-missing', '--workflows-dir and --ruleset-file', { workflowsDir, rulesetPath }, 'Provide both trusted workflow and ruleset inputs.');
  const ruleset = JSON.parse(readFileSync(resolve(rulesetPath), 'utf8'));
  return validateRuntimeProjection(contract, resolve(workflowsDir), ruleset);
}

if (import.meta.main) {
  const resultValue = runCli();
  process.stdout.write(`${JSON.stringify(resultValue, null, 2)}\n`);
  if (!resultValue.ok) process.exitCode = 1;
}
