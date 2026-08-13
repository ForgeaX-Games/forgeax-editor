import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  discoverBrowserReleaseCandidates,
  validateBrowserReleaseDiscovery,
} from './browser-release-portfolio.mjs';
import {
  LANDED_REQUIRED_CONTEXTS,
  validateAdmissionDelivery,
  validateLandedDelivery,
} from './editor-ci-contract-envelope.mjs';
import { buildWorkflowGraph, extractRequiredContexts } from './ci-baseline.mjs';
import { validateWorkflowBinding } from './editor-ci-workflow-binding.mjs';
import { discoverLiveRulesetSync, requiredContextNamesFromRuleset } from './live-ruleset-admission.mjs';

export {
  ADMISSION_ENVELOPE_FIELDS,
  ADMISSION_SCHEMA_VERSION,
  LANDED_REQUIRED_CONTEXTS,
  createAdmissionEnvelope,
  digestAdmissionValue,
  validateAdmissionDelivery,
  validateAdmissionEnvelope,
  validateLandedDelivery,
} from './editor-ci-contract-envelope.mjs';

export const CONTRACT_SCHEMA_VERSION = 'forgeax-editor-ci-contract/v1';
export const EXECUTION_HOMES = [
  'local-fast',
  'local-full',
  'PR',
  'main',
  'nightly/scheduled',
  'post-merge',
];
export const REQUIRED_CONTEXTS = LANDED_REQUIRED_CONTEXTS;
export const FAILURE_CLASSES = ['admission', 'environment', 'source', 'external-transport'];
export const PORTFOLIO_SCHEMA_VERSION = 'forgeax-browser-release-portfolio/v1';
export const PORTFOLIO_SOURCE_PATH_PATTERN = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9_][a-z0-9._-]*)*$/;
export const PORTFOLIO_EVIDENCE_FIELDS = [
  'sourceSha',
  'contractDigest',
  'admissionGeneration',
  'terminalStatus',
  'expected',
  'observed',
];
export const PREREQUISITE_RELEASE_SCHEMA_VERSION = 'forgeax-prerequisite-release/v1';
export const PREREQUISITE_PAYLOAD_CLASSES = [
  'engine-dist',
  'wgpu-wasm',
  'fbx-wasm',
  'bun-install-facts',
  'editor-generated-inputs',
];
export const PREREQUISITE_CONSUMERS = [
  'b2-self-boot',
  'typecheck',
  'smoke-play',
  'submodule-pin',
];
export const PREREQUISITE_IDENTITY_FIELDS = [
  'artifactId',
  'releaseDigest',
  'schemaVersion',
  'inventory',
  'producerRunId',
  'producerAttempt',
  'sourceSha',
  'recursivePins',
  'producerSuccess',
];
export const PREREQUISITE_MANIFEST_FIELDS = [
  'schemaVersion',
  'artifactId',
  'releaseDigest',
  'inventory',
  'producerRunId',
  'producerAttempt',
  'sourceSha',
  'recursivePins',
  'producerSuccess',
  'producerEnvironmentFingerprint',
  'compatibility',
];
export const PREREQUISITE_COMPATIBILITY_FIELDS = [
  'os',
  'architecture',
  'bunVersion',
  'nodeVersion',
  'pnpmVersion',
  'rustVersion',
  'wasmPackVersion',
  'capacityPool',
];

export const DEFAULT_ADMISSION_ALLOWLIST = [
  { kind: 'prefix', value: 'ci/' },
  { kind: 'prefix', value: 'scripts/ci/' },
  { kind: 'prefix', value: '.github/workflows/' },
  { kind: 'exact', value: 'package.json' },
];

function matchesAllowlist(path, rule) {
  return rule.kind === 'exact' ? path === rule.value : rule.kind === 'prefix' && path.startsWith(rule.value);
}

function isRepositoryRelativePath(path) {
  return typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.split('/').includes('..');
}

export function projectAdmissionChanges(changedFiles, allowlist = DEFAULT_ADMISSION_ALLOWLIST) {
  if (!Array.isArray(changedFiles) || !Array.isArray(allowlist)) {
    const error = issue('changed-file-allowlist-input-invalid', 'arrays of changed files and allowlist rules', { changedFiles, allowlist }, 'Provide repository-relative changed files and explicit admission allowlist rules.');
    return { ok: false, allowed: [], rejected: [], error };
  }
  const normalized = [...new Set(changedFiles)];
  const invalidPath = normalized.find((path) => !isRepositoryRelativePath(path));
  if (invalidPath) {
    return {
      ok: false,
      allowed: [],
      rejected: normalized,
      error: issue('changed-file-path-invalid', 'repository-relative paths without traversal', invalidPath, 'Use repository-relative changed files and reject absolute or parent-traversal paths.'),
    };
  }
  const allowed = normalized.filter((path) => allowlist.some((rule) => matchesAllowlist(path, rule)));
  const rejected = normalized.filter((path) => !allowed.includes(path));
  if (rejected.length > 0) {
    return {
      ok: false,
      allowed,
      rejected,
      error: issue(
        'changed-file-outside-admission-allowlist',
        allowlist,
        rejected,
        'Keep admission changes in the repo-root CI control plane; do not absorb product source or old loop-state.',
      ),
    };
  }
  return { ok: true, allowed, rejected: [] };
}

const SHA1 = /^[a-f0-9]{40}$/;
const HARNESS_FEATURE_ROOT = 'forgeax-loop/';
const EDITOR_SOURCE_PREFIXES = ['ci/', 'scripts/', '.github/', 'package.json'];

function isSafeDeliveryPath(path) {
  return typeof path === 'string'
    && path.length > 0
    && !path.startsWith('/')
    && !path.split('/').includes('..');
}

function normalizeFeatureDir(featureDir, featureId) {
  if (typeof featureDir !== 'string' || typeof featureId !== 'string' || featureId.length === 0) return null;
  const marker = '.forgeax-harness/';
  const relative = featureDir.includes(marker)
    ? featureDir.slice(featureDir.indexOf(marker) + marker.length)
    : featureDir;
  const expected = `${HARNESS_FEATURE_ROOT}${featureId}`;
  return relative === expected ? expected : null;
}

function isEditorSourcePath(path) {
  return EDITOR_SOURCE_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix));
}

function deliveryHandoff(status, error, blocker, requiredEvidence, nextAction, extra = {}) {
  return {
    ok: status === 'delivered',
    status,
    error,
    handoff: {
      blocker,
      owner: 'release owner',
      requiredEvidence,
      nextAction,
    },
    ...extra,
  };
}

function deliveryIssue(code, expected, observed, hint) {
  return { code, expected, observed, hint };
}

function deliveryPending(code, expected, observed, hint, blocker, requiredEvidence, nextAction, extra = {}) {
  return deliveryHandoff(
    'pending',
    deliveryIssue(code, expected, observed, hint),
    blocker,
    requiredEvidence,
    nextAction,
    extra,
  );
}

function deliveryNonpass(code, expected, observed, hint, blocker, requiredEvidence, nextAction, extra = {}) {
  return deliveryHandoff(
    'nonpass',
    deliveryIssue(code, expected, observed, hint),
    blocker,
    requiredEvidence,
    nextAction,
    extra,
  );
}

function validateSourceDelivery(sourceDelivery) {
  if (!isObject(sourceDelivery) || sourceDelivery.repository !== 'editor' || !SHA1.test(sourceDelivery.commitSha ?? '') || !Array.isArray(sourceDelivery.changedPaths)) {
    return deliveryPending(
      'source-delivery-evidence-missing',
      {repository: 'editor', commitSha: '40-character lowercase SHA', changedPaths: 'array'},
      sourceDelivery ?? 'missing',
      'Record the editor source commit separately from the floating harness commit.',
      'editor source delivery evidence is missing or malformed',
      ['editor repository', 'editor source commit SHA', 'source changed paths'],
      'Record the source branch commit before selecting a harness delivery.',
    );
  }
  const invalidPath = sourceDelivery.changedPaths.find((path) => !isSafeDeliveryPath(path));
  if (invalidPath) {
    return deliveryNonpass(
      'source-delivery-path-invalid',
      'repository-relative source paths',
      invalidPath,
      'Do not use absolute or traversal paths in a source delivery record.',
      'source delivery contains an invalid path',
      ['source changed paths'],
      'Recreate the source delivery record with repository-relative paths.',
    );
  }
  const mixedPath = sourceDelivery.changedPaths.find((path) => path.startsWith('.forgeax-harness/'));
  if (mixedPath) {
    return deliveryNonpass(
      'delivery-boundary-mixed',
      'editor source paths without floating harness artifacts',
      mixedPath,
      'The editor source repository and floating harness repository must be delivered independently.',
      'editor source and harness artifacts were mixed',
      ['separate editor source commit', 'separate harness commit'],
      'Remove harness paths from the editor source delivery and push the two repositories independently.',
    );
  }
  return null;
}

function validateHarnessPaths(harnessDelivery, featureDir, featureId) {
  if (!Array.isArray(harnessDelivery.selectedPaths) || harnessDelivery.selectedPaths.length === 0) {
    return deliveryPending(
      'harness-selected-paths-missing',
      `at least one path under ${featureDir}/`,
      harnessDelivery.selectedPaths ?? 'missing',
      'Select only formal loop artifacts owned by this feature.',
      'feature harness artifact selection is empty',
      [`${featureDir}/<artifact>`],
      `Select the formal loop artifacts under ${featureDir}/ without selecting other features.`,
    );
  }
  const seen = new Set();
  for (const path of harnessDelivery.selectedPaths) {
    if (!isSafeDeliveryPath(path)) {
      return deliveryNonpass(
        'harness-selected-path-invalid',
        'repository-relative harness paths',
        path,
        'Do not select absolute or traversal paths from the floating harness repository.',
        'selected harness path is invalid',
        [`${featureDir}/<artifact>`],
        'Recreate the selection with repository-relative feature paths.',
      );
    }
    if (seen.has(path)) {
      return deliveryNonpass(
        'harness-selected-path-duplicate',
        'unique selected feature paths',
        path,
        'Select each feature artifact once; do not create duplicate delivery records.',
        'a feature harness path was selected twice',
        [`${featureDir}/<artifact>`],
        'Deduplicate the selected harness paths before committing the feature handoff.',
      );
    }
    seen.add(path);
    if (!path.startsWith(`${featureDir}/`)) {
      const code = isEditorSourcePath(path) ? 'delivery-boundary-mixed' : 'harness-feature-path-mismatch';
      const hint = code === 'delivery-boundary-mixed'
        ? 'Editor source files cannot be selected into a floating harness commit.'
        : `Only ${featureId}'s formal loop artifact directory may be selected.`;
      const blocker = code === 'delivery-boundary-mixed'
        ? 'editor source and harness artifacts were mixed'
        : 'selected path belongs to another feature or loop';
      return deliveryNonpass(
        code,
        `${featureDir}/<artifact>`,
        path,
        hint,
        blocker,
        [`${featureDir}/<artifact>`],
        'Keep editor source delivery and feature harness delivery in separate repositories and commits.',
      );
    }
  }
  return null;
}

function validateHarnessWorkspaceState(harness, featureDir) {
  const dirtyPaths = Array.isArray(harness.dirtyPaths) ? harness.dirtyPaths : [];
  const untrackedPaths = Array.isArray(harness.untrackedPaths) ? harness.untrackedPaths : [];
  const unrelatedDirty = dirtyPaths.find((path) => !path.startsWith(`${featureDir}/`));
  if (unrelatedDirty) {
    return deliveryPending(
      'harness-unrelated-dirty-content',
      `no dirty paths outside ${featureDir}/`,
      unrelatedDirty,
      'Preserve unrelated concurrent harness content; do not clean or include it in this feature delivery.',
      'unrelated harness dirty content must remain with its owner',
      [unrelatedDirty, 'feature-owned harness paths'],
      'Leave the unrelated harness path untouched and select only this feature directory.',
      {preservedPaths: dirtyPaths.filter((path) => path !== unrelatedDirty)},
    );
  }
  const unrelatedUntracked = untrackedPaths.find((path) => !path.startsWith(`${featureDir}/`));
  if (unrelatedUntracked) {
    return deliveryPending(
      'harness-unrelated-untracked-content',
      `no untracked paths outside ${featureDir}/`,
      unrelatedUntracked,
      'Preserve unrelated concurrent harness content; do not clean or include it in this feature delivery.',
      'unrelated harness untracked content must remain with its owner',
      [unrelatedUntracked, 'feature-owned harness paths'],
      'Leave the unrelated harness path untouched and select only this feature directory.',
      {preservedPaths: untrackedPaths.filter((path) => path !== unrelatedUntracked)},
    );
  }
  const featureDirty = dirtyPaths.find((path) => path.startsWith(`${featureDir}/`)) || untrackedPaths.find((path) => path.startsWith(`${featureDir}/`));
  if (featureDirty) {
    return deliveryPending(
      'harness-feature-dirty-content',
      `clean feature-owned harness paths under ${featureDir}/`,
      featureDirty,
      'The selected feature artifact set must be committed before a remote delivery can be claimed.',
      'feature harness content is not committed',
      [featureDirty, 'harness commit containing the feature artifacts'],
      'Commit the feature-owned harness artifacts, then verify the remote commit SHA.',
    );
  }
  return null;
}

function validateHarnessRemote(harness) {
  const remote = harness.remote;
  if (!isObject(remote) || remote.reachable !== true || remote.name !== 'origin' || remote.ref !== 'main' || !SHA1.test(remote.sha ?? '')) {
    return deliveryPending(
      'harness-remote-push-missing',
      {name: 'origin', ref: 'main', reachable: true, sha: harness.commitSha},
      remote ?? 'missing',
      'A local harness commit is not delivery evidence until the remote can locate the same commit.',
      'feature harness commit is not reachable from the harness remote',
      ['harness remote ref', 'remote harness commit SHA'],
      'Push the feature harness commit to the harness remote and record git ls-remote evidence.',
    );
  }
  if (remote.sha !== harness.commitSha) {
    return deliveryNonpass(
      'harness-remote-sha-mismatch',
      harness.commitSha,
      remote.sha,
      'The remote SHA must identify the exact feature harness commit selected for delivery.',
      'harness remote points at a different commit',
      ['local harness commit SHA', 'remote harness commit SHA'],
      'Push or re-resolve the exact feature harness commit without force-pushing unrelated content.',
    );
  }
  return null;
}

export function selectHarnessDelivery(input) {
  if (!isObject(input) || typeof input.featureId !== 'string' || input.featureId.length === 0) {
    return deliveryPending(
      'harness-feature-identity-missing',
      'featureId and featureDir identify one formal loop artifact directory',
      input ?? 'missing',
      'Select a named feature directory before inspecting harness delivery.',
      'feature harness identity is missing',
      ['featureId', 'featureDir'],
      'Pass the current feature ID and its formal loop artifact directory.',
    );
  }
  const featureDir = normalizeFeatureDir(input.featureDir, input.featureId);
  if (!featureDir) {
    return deliveryNonpass(
      'harness-feature-path-mismatch',
      `${HARNESS_FEATURE_ROOT}${input.featureId}`,
      input.featureDir ?? 'missing',
      'The selected harness directory must be the current feature loop directory.',
      'feature harness directory does not match feature identity',
      [`${HARNESS_FEATURE_ROOT}${input.featureId}/<artifact>`],
      'Use only the current feature loop directory; do not select old four-gate or another feature state.',
    );
  }
  const sourceIssue = validateSourceDelivery(input.sourceDelivery);
  if (sourceIssue) return sourceIssue;
  const harness = input.harnessDelivery;
  if (!isObject(harness) || harness.repository !== 'harness' || !SHA1.test(harness.commitSha ?? '')) {
    return deliveryPending(
      'harness-commit-evidence-missing',
      {repository: 'harness', commitSha: '40-character lowercase SHA'},
      harness ?? 'missing',
      'A local harness worktree is not a remote delivery until its immutable commit is recorded.',
      'feature harness commit evidence is missing',
      ['harness repository', 'feature harness commit SHA'],
      'Commit only the selected feature paths in the harness repository before checking its remote.',
    );
  }
  const workspaceIssue = validateHarnessWorkspaceState(harness, featureDir);
  if (workspaceIssue) return workspaceIssue;
  const pathIssue = validateHarnessPaths(harness, featureDir, input.featureId);
  if (pathIssue) return pathIssue;
  const remoteIssue = validateHarnessRemote(harness);
  if (remoteIssue) return remoteIssue;
  return {
    ok: true,
    status: 'delivered',
    featureId: input.featureId,
    featureDir,
    sourceCommitSha: input.sourceDelivery.commitSha,
    harnessCommitSha: harness.commitSha,
    selectedPaths: [...harness.selectedPaths],
    remote: structuredClone(harness.remote),
  };
}

export function validateDeliveryState(input, options = {}) {
  const landed = validateLandedDelivery(input?.landed ?? input, options);
  if (!landed.ok) return {ok: false, status: landed.status, phase: 'landed', error: landed.error, handoff: landed.handoff};
  const admission = validateAdmissionDelivery(input);
  if (!admission.ok) return {ok: false, status: admission.status, phase: 'admission', error: admission.error, handoff: admission.handoff};
  const harness = selectHarnessDelivery(input);
  if (!harness.ok) return {ok: false, status: harness.status, phase: 'harness', error: harness.error, handoff: harness.handoff};
  return {ok: true, status: 'pass', landed, admission, harness};
}

export const validateDelivery = validateDeliveryState;

function issue(code, expected, observed, hint) {
  return { code, expected, observed, hint };
}

function result(errors = [], extra = {}) {
  return { ok: errors.length === 0, errors, ...extra };
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
  if (check.runnerPool !== undefined && (typeof check.runnerPool !== 'string' || !['standard', 'heavy'].includes(check.runnerPool))) {
    return issue(
      'schema-field-type',
      `checks[${index}].runnerPool is standard or heavy`,
      check.runnerPool,
      'Declare a concrete self-hosted capability pool for checks bound to required contexts.',
    );
  }
  if (check.permissions !== undefined) {
    if (!isObject(check.permissions)) {
      return issue('schema-field-type', `checks[${index}].permissions is an object`, check.permissions, 'Declare least-privilege permissions as a mapping.');
    }
    const invalidPermission = Object.entries(check.permissions).find(([, value]) => !['read', 'write', 'none'].includes(value));
    if (invalidPermission) {
      return issue('schema-field-type', `checks[${index}].permissions values are read, write, or none`, invalidPermission, 'Use explicit GitHub permission levels.');
    }
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

function validateDeliverySchema(delivery) {
  if (!isObject(delivery)) {
    return issue('delivery-schema-invalid', 'delivery is an object', delivery, 'Declare the delivery verifier beside the producer-owned contract.');
  }
  if (delivery.requiredContextsRef !== 'requiredContexts') {
    return issue('delivery-required-context-ref-invalid', 'requiredContexts', delivery.requiredContextsRef, 'Reuse the existing requiredContexts SSOT for landed delivery.');
  }
  if (delivery.measurementRequired !== false) {
    return issue('delivery-measurement-required-invalid', false, delivery.measurementRequired, 'Keep browser measurement outside the production required delivery gate.');
  }
  if (!isObject(delivery.verifier) || delivery.verifier.entrypoint !== 'scripts/ci/editor-ci-contract.mjs' || delivery.verifier.command !== 'bun run ci:delivery') {
    return issue(
      'delivery-verifier-invalid',
      {entrypoint: 'scripts/ci/editor-ci-contract.mjs', command: 'bun run ci:delivery'},
      delivery.verifier,
      'Expose landed and harness delivery through the existing editor CI contract owner path.',
    );
  }
  if (delivery.sourceRepository !== 'editor' || delivery.harnessRepository !== 'floating-harness') {
    return issue(
      'delivery-repository-boundary-invalid',
      {sourceRepository: 'editor', harnessRepository: 'floating-harness'},
      {sourceRepository: delivery.sourceRepository, harnessRepository: delivery.harnessRepository},
      'Keep editor source and floating harness as separate delivery repositories.',
    );
  }
  return null;
}

function validatePortfolioSchema(portfolio) {
  if (!isObject(portfolio)) return issue('schema-field-type', 'browserReleasePortfolio is an object', portfolio, 'Declare browserReleasePortfolio inside the producer-owned CI contract.');
  if (portfolio.owner === undefined) return issue('portfolio-owner-missing', 'browserReleasePortfolio.owner is present', 'missing', 'Record the current producer owner before projecting browser/release units.');
  if (portfolio.owner !== 'editor-ci') return issue('portfolio-owner-invalid', 'editor-ci', portfolio.owner, 'Keep browserReleasePortfolio owned by the existing editor-ci contract producer.');
  if (portfolio.schemaVersion !== PORTFOLIO_SCHEMA_VERSION) return issue('portfolio-schema-version', PORTFOLIO_SCHEMA_VERSION, portfolio.schemaVersion, 'Use the supported nested browser release portfolio schema.');
  if (portfolio.parentCheckId !== 'smoke-play') return issue('portfolio-parent-invalid', 'smoke-play', portfolio.parentCheckId, 'Project every browser child to the existing smoke-play parent.');
  if (portfolio.requiredContextsRef !== 'requiredContexts') return issue('portfolio-required-context-ref-invalid', 'requiredContexts', portfolio.requiredContextsRef, 'Reference the existing top-level requiredContexts array instead of copying it.');
  if (!isObject(portfolio.measurement)) return issue('portfolio-measurement-invalid', 'measurement is an object', portfolio.measurement, 'Declare measurement as a non-required projection in the portfolio contract.');
  if (portfolio.measurement.required !== false) return issue('portfolio-measurement-required', false, portfolio.measurement.required, 'Keep measurement as a temporary non-required projection; only smoke-play remains the parent.');
  if (!isObject(portfolio.evidence)) return issue('portfolio-evidence-invalid', 'evidence is an object', portfolio.evidence, 'Declare the shared evidence envelope fields in the producer contract.');
  if (portfolio.evidence.schemaVersion !== 'forgeax-browser-release-evidence/v1') return issue('portfolio-evidence-schema-version', 'forgeax-browser-release-evidence/v1', portfolio.evidence.schemaVersion, 'Use the supported evidence envelope schema.');
  if (JSON.stringify(portfolio.evidence.requiredFields) !== JSON.stringify(PORTFOLIO_EVIDENCE_FIELDS)) return issue('portfolio-evidence-fields-invalid', PORTFOLIO_EVIDENCE_FIELDS, portfolio.evidence.requiredFields, 'Keep source, admission, terminal, expected, and observed fields discoverable to AI consumers.');
  if (JSON.stringify(portfolio.evidence.failureFields) !== JSON.stringify(['code', 'hint', 'expected', 'observed'])) return issue('portfolio-error-fields-invalid', ['code', 'hint', 'expected', 'observed'], portfolio.evidence.failureFields, 'Expose structured error properties instead of requiring log parsing.');
  if (!isObject(portfolio.discovery)) return issue('portfolio-discovery-invalid', 'discovery is an object', portfolio.discovery, 'Declare the producer-owned discovery roots and source disposition policy.');
  if (!Array.isArray(portfolio.discovery.ownedSources)) return issue('portfolio-source-list-invalid', 'an array of owned source paths', portfolio.discovery.ownedSources, 'Let dynamic census resolve the producer-owned source paths.');
  const sourceSet = new Set(portfolio.discovery.ownedSources);
  if (sourceSet.size !== portfolio.discovery.ownedSources.length) return issue('portfolio-source-duplicate', 'six unique producer-owned source paths', portfolio.discovery.ownedSources, 'Remove duplicate source bindings instead of adding a second unit roster.');
  if (portfolio.discovery.ownedSources.length !== 6 || portfolio.discovery.ownedSources.some((source) => !PORTFOLIO_SOURCE_PATH_PATTERN.test(source))) return issue('portfolio-source-list-invalid', 'six stable repository-relative source paths with path-safe directory names', portfolio.discovery.ownedSources, 'Keep the six current sources discoverable from the candidate census.');
  for (const field of ['unmatchedDisposition', 'exclusionClass', 'exclusionOwner']) {
    if (typeof portfolio.discovery[field] !== 'string' || portfolio.discovery[field].length === 0) return issue('portfolio-discovery-field-invalid', `discovery.${field} is a non-empty string`, portfolio.discovery[field], `Declare discovery.${field} so every unmatched candidate has an explicit disposition.`);
  }
  if (!isObject(portfolio.profiles) || !isObject(portfolio.profiles['browser-journey']) || !isObject(portfolio.profiles['release-script'])) return issue('portfolio-profiles-invalid', 'browser-journey and release-script profile objects', portfolio.profiles, 'Declare profile-owned unit and evidence fields without creating a second roster.');
  return null;
}

function validatePrerequisitePayloadClasses(payloadClasses) {
  if (!isObject(payloadClasses)) {
    return issue(
      'prerequisite-release-payload-classes-invalid',
      'payloadClasses is an object',
      payloadClasses,
      'Declare one logical payload class map inside prerequisiteRelease.',
    );
  }
  const unknownPayload = Object.keys(payloadClasses).find(
    (payloadClass) => !PREREQUISITE_PAYLOAD_CLASSES.includes(payloadClass),
  );
  if (unknownPayload) {
    return issue(
      'prerequisite-release-payload-unknown',
      PREREQUISITE_PAYLOAD_CLASSES,
      unknownPayload,
      'Use a declared logical payload class instead of inventing a release inventory key.',
    );
  }
  const missingPayload = PREREQUISITE_PAYLOAD_CLASSES.find(
    (payloadClass) => !Object.hasOwn(payloadClasses, payloadClass),
  );
  if (missingPayload) {
    return issue(
      'prerequisite-release-payload-missing',
      PREREQUISITE_PAYLOAD_CLASSES,
      missingPayload,
      'Declare every supported logical payload class, including optional editor-generated-inputs.',
    );
  }
  for (const payloadClass of PREREQUISITE_PAYLOAD_CLASSES) {
    const definition = payloadClasses[payloadClass];
    if (!isObject(definition) || !Array.isArray(definition.paths) || typeof definition.optional !== 'boolean') {
      return issue(
        'prerequisite-release-payload-definition-invalid',
        `${payloadClass} has paths and optional fields`,
        definition,
        `Declare ${payloadClass} with repository-relative paths and an explicit optional flag.`,
      );
    }
  }
  return null;
}

function validatePrerequisiteConsumers(consumers) {
  if (!isObject(consumers)) {
    return issue(
      'prerequisite-release-consumers-invalid',
      'consumers is an object',
      consumers,
      'Declare the active consumer-to-payload map inside prerequisiteRelease.',
    );
  }
  const unknownConsumer = Object.keys(consumers).find(
    (consumer) => !PREREQUISITE_CONSUMERS.includes(consumer),
  );
  if (unknownConsumer) {
    return issue(
      'prerequisite-release-consumer-unknown',
      PREREQUISITE_CONSUMERS,
      unknownConsumer,
      'Map only named required checks to release payload classes.',
    );
  }
  const missingConsumer = PREREQUISITE_CONSUMERS.find(
    (consumer) => !Object.hasOwn(consumers, consumer),
  );
  if (missingConsumer) {
    return issue(
      'prerequisite-release-consumer-missing',
      PREREQUISITE_CONSUMERS,
      missingConsumer,
      'Declare every existing required check, including consumers with no release dependency.',
    );
  }
  for (const consumer of PREREQUISITE_CONSUMERS) {
    const requested = consumers[consumer];
    if (!Array.isArray(requested) || requested.some((payloadClass) => typeof payloadClass !== 'string')) {
      return issue(
        'prerequisite-release-consumer-map-invalid',
        `${consumer} maps to an array of payload class IDs`,
        requested,
        `Declare ${consumer}'s release dependency as a payload class array.`,
      );
    }
    if (new Set(requested).size !== requested.length) {
      return issue(
        'prerequisite-release-consumer-duplicate-payload',
        'each consumer requests each payload class once',
        requested,
        `Remove repeated payload classes from ${consumer}'s declaration.`,
      );
    }
    const unknownPayload = requested.find(
      (payloadClass) => !PREREQUISITE_PAYLOAD_CLASSES.includes(payloadClass),
    );
    if (unknownPayload) {
      return issue(
        'prerequisite-release-payload-unknown',
        PREREQUISITE_PAYLOAD_CLASSES,
        unknownPayload,
        `Use a declared payload class in ${consumer}'s dependency map.`,
      );
    }
  }
  return null;
}

function validatePrerequisiteReleaseMaps(prerequisiteRelease) {
  for (const profile of ['PR', 'main', 'nightly/scheduled', 'post-merge']) {
    const consumers = prerequisiteRelease.activeProfiles[profile];
    if (!Array.isArray(consumers) || consumers.some((consumer) => !PREREQUISITE_CONSUMERS.includes(consumer))) {
      return issue(
        'prerequisite-release-profile-map-invalid',
        `${profile} maps to named consumers`,
        consumers,
        `Declare the ${profile} active release consumers without adding a required context.`,
      );
    }
  }
  return null;
}

function validatePrerequisiteReleaseFieldLists(prerequisiteRelease) {
  if (JSON.stringify(prerequisiteRelease.identity.fields) !== JSON.stringify(PREREQUISITE_IDENTITY_FIELDS)) {
    return issue(
      'prerequisite-release-identity-fields',
      PREREQUISITE_IDENTITY_FIELDS,
      prerequisiteRelease.identity.fields,
      'Keep producer identity fields complete and separate from compatibility and landed delivery identity.',
    );
  }
  if (JSON.stringify(prerequisiteRelease.manifest.requiredFields) !== JSON.stringify(PREREQUISITE_MANIFEST_FIELDS)) {
    return issue(
      'prerequisite-release-manifest-fields',
      PREREQUISITE_MANIFEST_FIELDS,
      prerequisiteRelease.manifest.requiredFields,
      'Declare every manifest provenance field required before a consumer uses payload bytes.',
    );
  }
  if (prerequisiteRelease.manifest.digestAlgorithm !== 'sha256') {
    return issue(
      'prerequisite-release-digest-algorithm',
      'sha256',
      prerequisiteRelease.manifest.digestAlgorithm,
      'Use SHA-256 for release and payload integrity evidence.',
    );
  }
  if (JSON.stringify(prerequisiteRelease.compatibility.fields) !== JSON.stringify(PREREQUISITE_COMPATIBILITY_FIELDS)) {
    return issue(
      'prerequisite-release-compatibility-fields',
      PREREQUISITE_COMPATIBILITY_FIELDS,
      prerequisiteRelease.compatibility.fields,
      'Keep runner and toolchain facts as explicit compatibility constraints, not artifact identity.',
    );
  }
  return null;
}

function validatePrerequisiteReleaseSchema(prerequisiteRelease) {
  if (prerequisiteRelease === undefined) {
    return issue(
      'prerequisite-release-missing',
      'prerequisiteRelease is present',
      'missing',
      'Add the versioned prerequisiteRelease surface to the existing editor CI contract.',
    );
  }
  if (!isObject(prerequisiteRelease)) {
    return issue(
      'prerequisite-release-type-invalid',
      'prerequisiteRelease is an object',
      prerequisiteRelease,
      'Keep prerequisiteRelease nested in the producer-owned contract.',
    );
  }
  if (prerequisiteRelease.schemaVersion !== PREREQUISITE_RELEASE_SCHEMA_VERSION) {
    return issue(
      'prerequisite-release-schema-version',
      PREREQUISITE_RELEASE_SCHEMA_VERSION,
      prerequisiteRelease.schemaVersion,
      'Use the supported versioned prerequisite release schema.',
    );
  }
  if (prerequisiteRelease.owner !== 'editor-ci' || prerequisiteRelease.producer !== 'prerequisite-release') {
    return issue(
      'prerequisite-release-owner-invalid',
      {owner: 'editor-ci', producer: 'prerequisite-release'},
      {owner: prerequisiteRelease.owner, producer: prerequisiteRelease.producer},
      'Keep one editor-ci-owned prerequisite release producer in the existing contract.',
    );
  }
  for (const [field, expected] of [
    ['payloadClasses', 'object'],
    ['consumers', 'object'],
    ['activeProfiles', 'object'],
    ['identity', 'object'],
    ['manifest', 'object'],
    ['compatibility', 'object'],
  ]) {
    const fieldIssue = firstIssueForField(prerequisiteRelease[field], `prerequisiteRelease.${field}`, expected);
    if (fieldIssue) return fieldIssue;
  }
  const payloadIssue = validatePrerequisitePayloadClasses(prerequisiteRelease.payloadClasses);
  if (payloadIssue) return payloadIssue;
  const consumerIssue = validatePrerequisiteConsumers(prerequisiteRelease.consumers);
  if (consumerIssue) return consumerIssue;
  const mapIssue = validatePrerequisiteReleaseMaps(prerequisiteRelease);
  if (mapIssue) return mapIssue;
  return validatePrerequisiteReleaseFieldLists(prerequisiteRelease);
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
    ['delivery', 'object'],
    ['browserReleasePortfolio', 'object'],
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
    validateDeliverySchema(contract.delivery),
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
  const prerequisiteIssue = validatePrerequisiteReleaseSchema(contract.prerequisiteRelease);
  if (prerequisiteIssue) return result([prerequisiteIssue]);
  const portfolioIssue = validatePortfolioSchema(contract.browserReleasePortfolio);
  if (portfolioIssue) return result([portfolioIssue]);
  return result();
}

export function projectBrowserReleasePortfolio(contract) {
  return contract?.browserReleasePortfolio ? structuredClone(contract.browserReleasePortfolio) : null;
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
    prerequisiteRelease: structuredClone(contract.prerequisiteRelease),
    browserReleasePortfolio: projectBrowserReleasePortfolio(contract),
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
  if (!Object.hasOwn(projection ?? {}, 'prerequisiteRelease')) {
    return result([
      issue(
        'projection-prerequisite-release-missing',
        'prerequisiteRelease is projected from the contract',
        'missing',
        'Regenerate the projection with the producer-owned prerequisiteRelease discovery index.',
      ),
    ]);
  }
  const projectedConsumers = projection.prerequisiteRelease?.consumers;
  if (isObject(projectedConsumers)) {
    const duplicateConsumerPayload = Object.entries(projectedConsumers).find(([, payloadClasses]) => (
      Array.isArray(payloadClasses) && new Set(payloadClasses).size !== payloadClasses.length
    ));
    if (duplicateConsumerPayload) {
      const error = issue(
        'projection-prerequisite-release-duplicate-payload',
        'each projected consumer requests each payload class once',
        duplicateConsumerPayload,
        'Regenerate the projection from the single prerequisiteRelease contract map.',
      );
      return result([error]);
    }
  }
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

function workflowSources(workflowsDir) {
  return workflowFiles(workflowsDir).map((file) => ({
    file,
    text: readFileSync(file, 'utf8'),
  }));
}

function rulesetContexts(ruleset) {
  try {
    return requiredContextNamesFromRuleset(ruleset);
  } catch {
    return [];
  }
}

function cliIssue(code, expected, observed, hint) {
  return result([issue(code, expected, observed, hint)]);
}

export function validateRuntimeProjection(contract, workflowsDir, ruleset, {includePortfolio = true} = {}) {
  const contractResult = validateContract(contract);
  if (!contractResult.ok) return contractResult;
  const liveContexts = rulesetContexts(ruleset);
  if (liveContexts.length === 0) return cliIssue('admission-ruleset-empty', REQUIRED_CONTEXTS, liveContexts, 'Provide a readable required-status-check ruleset input.');
  const expectedContexts = contract.requiredContexts.map((entry) => entry.context).sort();
  if (new Set(liveContexts).size !== liveContexts.length) {
    return cliIssue('required-context-shadowed', 'one live ruleset record per required context', liveContexts, 'Reject shadowed duplicate required contexts before workflow binding.');
  }
  if (JSON.stringify(liveContexts.slice().sort()) !== JSON.stringify(expectedContexts)) {
    const missing = expectedContexts.filter((context) => !liveContexts.includes(context));
    const extra = liveContexts.filter((context) => !expectedContexts.includes(context));
    return cliIssue('required-context-drift', {contexts: expectedContexts, missing: [], extra: []}, {contexts: liveContexts, missing, extra}, 'Align live required contexts with the producer-owned contract; missing and extra names are fail-closed drift.');
  }
  let binding;
  try {
    const graph = buildWorkflowGraph(workflowSources(workflowsDir), extractRequiredContexts(ruleset));
    binding = validateWorkflowBinding(contract, graph);
  } catch (error) {
    return cliIssue(
      error.code === 'workflow-graph-empty' ? 'zero-job' : error.code ?? 'workflow-admission',
      'trusted workflow graph can be parsed and admitted',
      error.message ?? String(error),
      'Fix the trusted workflow, runner capability, permission set, or live ruleset before success classification.',
    );
  }
  if (!binding.ok) return binding;
  const root = resolve(workflowsDir, '..', '..');
  if (!includePortfolio) return result([], {binding});
  const discovery = discoverBrowserReleaseCandidates(root, contract.browserReleasePortfolio);
  const discoveryResult = validateBrowserReleaseDiscovery(discovery, contract.browserReleasePortfolio);
  if (!discoveryResult.ok) return discoveryResult;
  return result([], {discovery: discoveryResult.value, binding});
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}

function ghJson(args) {
  const output = execFileSync('gh', ['api', ...args], {
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(output);
}

function repositoryForLiveRuleset(args) {
  const explicit = optionValue(args, '--repository');
  if (explicit) return explicit;
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const output = execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner'], {
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const value = JSON.parse(output)?.nameWithOwner;
  if (typeof value !== 'string' || value.length === 0) throw new Error('gh repo view did not return nameWithOwner');
  return value;
}

export function runCli(args = process.argv.slice(2)) {
  const contractPath = resolve('scripts/ci/editor-ci-contract.json');
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  const contractResult = validateContract(contract);
  if (!contractResult.ok) return contractResult;
  if (args.includes('--delivery')) {
    const deliveryPath = optionValue(args, '--delivery-input');
    if (!deliveryPath) return cliIssue('delivery-input-missing', '--delivery-input PATH', 'missing', 'Provide structured landed and harness evidence; the verifier never infers external delivery facts locally.');
    let deliveryInput;
    try {
      deliveryInput = JSON.parse(readFileSync(resolve(deliveryPath), 'utf8'));
    } catch (error) {
      return cliIssue('delivery-input-unreadable', 'readable JSON delivery evidence', String(error), 'Provide a readable JSON evidence file produced from the landed and harness delivery boundaries.');
    }
    const deliveryResult = validateDeliveryState(deliveryInput, {
      requiredContexts: contract.requiredContexts.map((entry) => entry.context),
    });
    if (!deliveryResult.ok) return deliveryResult;
    return {ok: true, status: 'pass', delivery: deliveryResult};
  }
  const workflowsDir = optionValue(args, '--workflows-dir');
  if (args.includes('--live-ruleset')) {
    try {
      const repository = repositoryForLiveRuleset(args);
      const discovery = discoverLiveRulesetSync({
        readRepository: () => ghJson([`repos/${repository}`]),
        readRulesets: () => ghJson(['--paginate', '--slurp', `repos/${repository}/rulesets?per_page=100`]),
        readDetail: (id) => ghJson([`repos/${repository}/rulesets/${id}`]),
      });
      if (!discovery.ok) return discovery;
      const projection = validateRuntimeProjection(
        contract,
        resolve(workflowsDir ?? '.github/workflows'),
        discovery.ruleset,
        {includePortfolio: !args.includes('--skip-portfolio')},
      );
      return {
        ...projection,
        liveRuleset: {
          id: discovery.ruleset.id,
          name: discovery.ruleset.name,
          enforcement: discovery.ruleset.enforcement,
          target: discovery.ruleset.target,
        },
        rulesetSelection: discovery.selection,
      };
    } catch (error) {
      return cliIssue('live-ruleset-unavailable', 'readable live ruleset API evidence', error.message ?? String(error), 'Use a read-only GitHub API reader and fail closed when repository, list, or detail evidence is unavailable.');
    }
  }
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
