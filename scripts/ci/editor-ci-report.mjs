/**
 * Public machine contract for CI reports. Consumers use fields, not log parsing.
 */

export const EDITOR_CI_REPORT_SCHEMA_VERSION = 'forgeax-editor-ci-report/v1';

export const REPORT_FIELDS = Object.freeze([
  'contractVersion',
  'checkId',
  'owner',
  'profile',
  'executionHome',
  'provenance',
  'terminalStatus',
  'failureClass',
  'code',
  'expected',
  'observed',
  'hint',
  'firstFailure',
  'attempts',
  'sloClaim',
  'prerequisiteRelease',
]);

const FAILURE_CLASSES = new Set(['admission', 'environment', 'source', 'external-transport']);
const TERMINAL_STATUSES = new Set(['pass', 'failure', 'skipped']);
export const EDITOR_CI_ORDINARY_CHECK_IDS = Object.freeze([
  'b2-self-boot',
  'typecheck',
  'r0-hierarchy-ui-editability',
  'r0-sample-vfx-skill',
  'r0-engine-dogfood-diagnostics',
  'submodule-pin',
  'smoke-play',
]);
export const EDITOR_CI_LOCAL_PROFILE_CHECK_ID = 'ci-profile';
const ORDINARY_CHECK_IDS = new Set(EDITOR_CI_ORDINARY_CHECK_IDS);
const PORTABILITY_PLATFORMS = new Set(['linux', 'windows', 'macos']);
export const PORTABILITY_TOOLCHAIN_KEYS = Object.freeze([
  'bun',
  'bunRevision',
  'node',
  'pnpm',
  'rust',
  'wasmPack',
  'emscripten',
]);
const PORTABILITY_STAGES = new Set([
  'checkout',
  'install',
  'setup',
  'wasm',
  'zero-binary',
  'type-static',
  'capability-probe',
  'smoke',
]);
const PORTABILITY_SKIP_STAGES = new Set(['capability-probe', 'smoke']);

function reportError(code, expected, observed, hint) {
  return { ok: false, error: { code, expected, observed, hint } };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function requiredString(report, field) {
  if (typeof report[field] !== 'string' || report[field].length === 0) {
    return reportError('report-field-missing', `non-empty ${field}`, report[field], `Include ${field} as a stable machine-readable field.`);
  }
  return null;
}

function validatePrerequisiteRelease(value) {
  if (value === null) return null;
  if (!isObject(value)) {
    return reportError(
      'report-prerequisite-release-invalid',
      'null or a prerequisite release object',
      value,
      'Project the producer release identity and validation outcome as structured fields.',
    );
  }
  for (const field of ['artifactId', 'releaseDigest', 'schemaVersion', 'producerRunId', 'sourceSha']) {
    const error = requiredString(value, field);
    if (error) return reportError('report-prerequisite-release-invalid', field, error.error.observed, error.error.hint);
  }
  if (!Number.isInteger(value.producerAttempt) || value.producerAttempt < 1) {
    return reportError('report-prerequisite-release-invalid', 'positive integer producerAttempt', value.producerAttempt, 'Preserve the producer run attempt as a numeric join field.');
  }
  if (typeof value.producerSuccess !== 'boolean') {
    return reportError('report-prerequisite-release-invalid', 'boolean producerSuccess', value.producerSuccess, 'Preserve whether the immutable producer completed successfully.');
  }
  if (!Array.isArray(value.recursivePins)) {
    return reportError('report-prerequisite-release-invalid', 'recursivePins array', value.recursivePins, 'Preserve recursive submodule pins without converting them into the landed SHA.');
  }
  if (!isObject(value.compatibility) || typeof value.compatibility.status !== 'string') {
    return reportError('report-prerequisite-release-invalid', 'compatibility.status', value.compatibility, 'Project compatibility as a structured validation outcome.');
  }
  if (!isObject(value.validation) || !['pass', 'failure'].includes(value.validation.status)) {
    return reportError('report-prerequisite-release-invalid', 'validation.status pass or failure', value.validation, 'Project the consumer validation result before the check body.');
  }
  if (typeof value.validation.consumer !== 'string' || value.validation.consumer.length === 0) {
    return reportError('report-prerequisite-release-invalid', 'validation.consumer', value.validation.consumer, 'Keep the request-scoped consumer identity in the report.');
  }
  if (value.validation.status === 'failure') {
    for (const field of ['code', 'expected', 'observed', 'affectedConsumer', 'hint']) {
      const error = requiredString(value.validation, field);
      if (error) return reportError('report-prerequisite-release-invalid', `validation.${field}`, error.error.observed, error.error.hint);
    }
  }
  return null;
}

function portabilityError(code, expected, observed, hint) {
  return reportError(code, expected, observed, hint);
}

export function validatePortabilityToolchain(toolchain, {allowIncomplete = false} = {}) {
  if (!isObject(toolchain)) {
    return portabilityError('report-portability-platform-invalid', 'platform.toolchain object', toolchain, 'Record each required toolchain identity in the platform report.');
  }
  const keys = Object.keys(toolchain);
  const unexpected = keys.filter((key) => !PORTABILITY_TOOLCHAIN_KEYS.includes(key));
  const missing = PORTABILITY_TOOLCHAIN_KEYS.filter((key) => !Object.hasOwn(toolchain, key));
  const invalid = PORTABILITY_TOOLCHAIN_KEYS.filter((key) => Object.hasOwn(toolchain, key) && (toolchain[key] === 'unknown' || !nonEmptyString(toolchain[key])));
  if (unexpected.length > 0 || (!allowIncomplete && (missing.length > 0 || invalid.length > 0))) {
    return portabilityError(
      'report-portability-toolchain-invalid',
      {keys: PORTABILITY_TOOLCHAIN_KEYS, values: 'non-empty observed command output'},
      {keys, missing, invalid, unexpected, toolchain},
      'Capture the canonical Bun, Bun revision, Node, pnpm, Rust, wasm-pack, and Emscripten command identities before publishing portability evidence.',
    );
  }
  return null;
}

function validatePortabilityPlatform(platform, allowIncompleteToolchain = false) {
  if (!isObject(platform)) return portabilityError('report-portability-platform-invalid', 'a platform object', platform, 'Record the platform OS, architecture, runner image, and toolchain identity.');
  if (!PORTABILITY_PLATFORMS.has(platform.os)) {
    return portabilityError('report-portability-platform-invalid', [...PORTABILITY_PLATFORMS], platform.os, 'Use the fixed Linux, Windows, or macOS portability platform set.');
  }
  for (const field of ['architecture', 'runnerImage']) {
    if (typeof platform[field] !== 'string' || platform[field].length === 0) {
      return portabilityError('report-portability-platform-invalid', `non-empty platform.${field}`, platform[field], `Record platform.${field} as a stable machine-readable fact.`);
    }
  }
  return validatePortabilityToolchain(platform.toolchain, {allowIncomplete: allowIncompleteToolchain});
}

function validatePortabilityCapability(capability, terminalStatus, stage) {
  if (capability === null) {
    if (terminalStatus === 'pass' && !PORTABILITY_SKIP_STAGES.has(stage)) return null;
    return portabilityError(
      'report-portability-capability-invalid',
      'capability facts or a required-stage failure projection',
      capability,
      'Keep capability null only for a successful required stage that does not produce capability facts.',
    );
  }
  if (!isObject(capability) || typeof capability.result !== 'string') {
    return portabilityError('report-portability-capability-invalid', 'capability.result', capability, 'Record the runtime capability probe as structured fields before smoke.');
  }
  if (capability.result === 'not-applicable') {
    if (terminalStatus !== 'failure' || PORTABILITY_SKIP_STAGES.has(stage) || capability.stage !== stage) {
      return portabilityError(
        'report-portability-capability-not-applicable-invalid',
        'not-applicable only for a matching required-stage failure',
        {capability, terminalStatus, stage},
        'Use not-applicable only when a required stage failed and its capability projection names that same stage.',
      );
    }
    return null;
  }
  if (!['supported', 'bounded-non-applicable'].includes(capability.result)) {
    return portabilityError('report-portability-capability-invalid', ['supported', 'bounded-non-applicable'], capability.result, 'Use a fact-backed supported result or a bounded non-applicable result.');
  }
  for (const field of ['navigatorGpu', 'adapter', 'device']) {
    if (typeof capability[field] !== 'boolean') {
      return portabilityError('report-portability-capability-facts-invalid', `boolean capability.${field}`, capability[field], 'Record every capability fact explicitly; missing facts cannot authorize smoke or a bounded skip.');
    }
  }
  if (!Array.isArray(capability.features)) {
    return portabilityError('report-portability-capability-facts-invalid', 'capability.features array', capability.features, 'Record the observed adapter feature list, including an empty list.');
  }
  if (capability.result === 'supported') {
    for (const field of ['browserMode', 'browserChannel', 'backend']) {
      if (!nonEmptyString(capability[field])) {
        return portabilityError('report-portability-capability-facts-invalid', `non-empty capability.${field}`, capability[field], 'Supported smoke requires the actual browser mode, channel, and backend identity.');
      }
    }
    if (capability.navigatorGpu !== true || capability.adapter !== true || capability.device !== true) {
      return portabilityError('report-portability-capability-facts-invalid', 'all supported capability booleans are true', capability, 'A supported result requires navigator.gpu, adapter, and device facts to be true.');
    }
  }
  if (capability.result === 'bounded-non-applicable') {
    if (capability.browserMode !== 'unavailable') {
      return portabilityError('report-portability-capability-boundary-invalid', 'browserMode unavailable for bounded non-applicable', capability.browserMode, 'A bounded skip must identify that neither supported browser mode was available.');
    }
    for (const field of ['boundary', 'hint']) {
      if (typeof capability[field] !== 'string' || capability[field].length === 0) {
        return portabilityError('report-portability-capability-invalid', `non-empty capability.${field}`, capability[field], `Include the capability boundary and executable recovery hint.`);
      }
    }
  }
  if (terminalStatus === 'skipped' && capability.result !== 'bounded-non-applicable') {
    return portabilityError('report-skipped-capability-invalid', 'bounded-non-applicable', capability.result, 'Only a fact-backed bounded capability result may be skipped.');
  }
  return null;
}

function validatePortabilityMatrix(matrix, sourceSha, expectedPlatform) {
  if (!isObject(matrix)) return portabilityError('report-portability-matrix-invalid', 'a matrix object', matrix, 'Project the platform aggregate and its terminal stage results.');
  if (matrix.kind !== 'platform') {
    return portabilityError('report-portability-matrix-kind-invalid', 'platform', matrix.kind, 'Use the shared editor-ci-report matrix projection for platform terminal reports.');
  }
  if (matrix.sourceSha !== sourceSha) {
    return portabilityError('report-matrix-source-sha-mismatch', sourceSha, matrix.sourceSha, 'Bind the aggregate to the same sourceSha as every platform report.');
  }
  if (!Array.isArray(matrix.platforms) || matrix.platforms.length !== 1 || matrix.platforms[0] !== expectedPlatform.os) {
    return portabilityError('report-portability-matrix-invalid', [...PORTABILITY_PLATFORMS], matrix.platforms, 'Use only the fixed Linux, Windows, and macOS matrix platforms.');
  }
  if (!Array.isArray(matrix.terminalResults) || matrix.terminalResults.length === 0) {
    return portabilityError('report-portability-matrix-invalid', 'a non-empty terminalResults array', matrix.terminalResults, 'Record one terminal result for each declared platform-stage unit.');
  }
  const seen = new Set();
  for (const result of matrix.terminalResults) {
    if (!isObject(result) || result.platform !== expectedPlatform.os || !PORTABILITY_STAGES.has(result.stage) || !TERMINAL_STATUSES.has(result.terminalStatus) || result.sourceSha !== sourceSha) {
      return portabilityError('report-matrix-terminal-invalid', 'platform, stage, and supported terminalStatus', result, 'Keep every matrix terminal result schema-valid and machine-readable.');
    }
    const key = `${result.platform}:${result.stage}`;
    if (seen.has(key)) return portabilityError('report-matrix-terminal-duplicate', 'one terminal result per platform-stage unit', key, 'Remove duplicate platform-stage results instead of aggregating competing outcomes.');
    seen.add(key);
  }
  return null;
}

function validatePortabilityAggregateReport(report) {
  const matrix = report.matrix;
  if (report.stage !== undefined || report.platform !== undefined || report.capability !== undefined) {
    return portabilityError('report-portability-aggregate-shape-invalid', 'aggregate report without platform, stage, or capability fields', report, 'Keep the aggregate as the shared editor-ci-report matrix projection.');
  }
  if (typeof report.sourceSha !== 'string' || !/^[a-f0-9]{40}$/.test(report.sourceSha)) {
    return portabilityError('report-portability-source-sha-invalid', '40-character lowercase source SHA', report.sourceSha, 'Bind the aggregate to the exact source checkout SHA.');
  }
  if (!isObject(matrix) || matrix.kind !== 'aggregate') {
    return portabilityError('report-portability-matrix-kind-invalid', 'aggregate', matrix?.kind, 'Use the shared editor-ci-report matrix projection for the same-run aggregate.');
  }
  if (matrix.sourceSha !== report.sourceSha) {
    return portabilityError('report-matrix-source-sha-mismatch', report.sourceSha, matrix.sourceSha, 'Bind the aggregate matrix to its top-level sourceSha.');
  }
  if (!Number.isInteger(matrix.workflowRunId) || matrix.workflowRunId < 1 || !Number.isInteger(matrix.workflowRunAttempt) || matrix.workflowRunAttempt < 1) {
    return portabilityError('report-portability-run-identity-invalid', 'positive workflowRunId and workflowRunAttempt', {workflowRunId: matrix.workflowRunId, workflowRunAttempt: matrix.workflowRunAttempt}, 'Carry the exact workflow run identity into the same aggregate artifact.');
  }
  if (!Array.isArray(matrix.platforms) || matrix.platforms.length !== PORTABILITY_PLATFORMS.size || !sameSet(matrix.platforms, PORTABILITY_PLATFORMS)) {
    return portabilityError('report-portability-platform-set-invalid', [...PORTABILITY_PLATFORMS], matrix.platforms, 'Aggregate exactly Linux, Windows, and macOS once.');
  }
  if (!Array.isArray(matrix.terminalResults) || matrix.terminalResults.length !== PORTABILITY_PLATFORMS.size * PORTABILITY_STAGES.size) {
    return portabilityError('report-matrix-terminal-invalid', PORTABILITY_PLATFORMS.size * PORTABILITY_STAGES.size, matrix.terminalResults, 'Record one terminal result for every platform-stage unit.');
  }
  const seen = new Set();
  for (const result of matrix.terminalResults) {
    const key = `${result?.platform}:${result?.stage}`;
    if (!isObject(result) || seen.has(key) || !PORTABILITY_PLATFORMS.has(result.platform) || !PORTABILITY_STAGES.has(result.stage) || result.sourceSha !== report.sourceSha || !TERMINAL_STATUSES.has(result.terminalStatus)) {
      return portabilityError('report-matrix-terminal-invalid', 'unique sourceSha-bound platform-stage terminal results', result, 'Reject duplicate, malformed, or cross-SHA aggregate terminal facts.');
    }
    seen.add(key);
    if (result.terminalStatus === 'failure' || (result.terminalStatus === 'skipped' && !PORTABILITY_SKIP_STAGES.has(result.stage))) {
      return portabilityError('report-matrix-terminal-nonpass', 'required stages pass and only capability/smoke may be bounded skipped', result, 'Never publish a passing aggregate when a required stage or capability fact failed.');
    }
  }
  const expectedKeys = new Set([...PORTABILITY_PLATFORMS].flatMap((platform) => [...PORTABILITY_STAGES].map((stage) => `${platform}:${stage}`)));
  if (!sameSet(seen, expectedKeys)) {
    return portabilityError('report-matrix-terminal-invalid', [...expectedKeys], [...seen], 'Preserve every platform-stage terminal unit exactly once.');
  }
  if (!Array.isArray(matrix.platformReports) || matrix.platformReports.length !== PORTABILITY_PLATFORMS.size) {
    return portabilityError('report-portability-platform-reports-invalid', PORTABILITY_PLATFORMS.size, matrix.platformReports, 'Embed the schema-valid native platform report arrays used to derive this aggregate.');
  }
  const platforms = new Set();
  for (const platformReport of matrix.platformReports) {
    if (!isObject(platformReport) || !validPlatformName(platformReport.platform) || platforms.has(platformReport.platform) || platformReport.sourceSha !== report.sourceSha || !Array.isArray(platformReport.reports) || platformReport.reports.length !== PORTABILITY_STAGES.size) {
      return portabilityError('report-portability-platform-reports-invalid', 'one complete sourceSha-bound report array per platform', platformReport, 'Validate and embed each native platform terminal report without reducing it to a status-only object.');
    }
    platforms.add(platformReport.platform);
    const stageNames = new Set();
    for (const stageReport of platformReport.reports) {
      const baseValidation = validateEditorCiReportBase(stageReport);
      if (!baseValidation.ok) return baseValidation;
      const validation = validatePortabilityStageReport(stageReport);
      if (validation) return validation;
      if (stageReport.platform.os !== platformReport.platform || stageReport.sourceSha !== report.sourceSha || stageNames.has(stageReport.stage)) {
        return portabilityError('report-portability-platform-stage-invalid', 'platform report stage identity matches its aggregate source and platform', stageReport, 'Keep nested stage reports source- and platform-bound.');
      }
      stageNames.add(stageReport.stage);
    }
    if (!sameSet(stageNames, PORTABILITY_STAGES)) return portabilityError('report-portability-platform-stage-invalid', [...PORTABILITY_STAGES], [...stageNames], 'Keep every native platform stage report.');
  }
  return sameSet(platforms, PORTABILITY_PLATFORMS) ? null : portabilityError('report-portability-platform-reports-invalid', [...PORTABILITY_PLATFORMS], [...platforms], 'Aggregate all three native platform report arrays.');
}

function validatePortabilityStageReport(report) {
  for (const field of ['sourceSha', 'platform', 'stage', 'capability', 'matrix']) {
    if (!Object.hasOwn(report, field)) return portabilityError('report-portability-field-missing', field, 'missing', `Include ${field} in every editor-portability report.`);
  }
  if (typeof report.sourceSha !== 'string' || !/^[a-f0-9]{40}$/.test(report.sourceSha)) {
    return portabilityError('report-portability-source-sha-invalid', '40-character lowercase source SHA', report.sourceSha, 'Bind portability evidence to the exact source checkout SHA.');
  }
  const setupFailed = Array.isArray(report.matrix?.terminalResults)
    && report.matrix.terminalResults.some((entry) => entry?.stage === 'setup' && entry?.terminalStatus === 'failure');
  const platformError = validatePortabilityPlatform(report.platform, report.terminalStatus === 'failure' || setupFailed);
  if (platformError) return platformError;
  if (!PORTABILITY_STAGES.has(report.stage)) {
    return portabilityError('report-portability-stage-invalid', [...PORTABILITY_STAGES], report.stage, 'Use one declared portability stage for each terminal report.');
  }
  if (report.terminalStatus === 'skipped' && !PORTABILITY_SKIP_STAGES.has(report.stage)) {
    return portabilityError('report-skipped-stage-invalid', [...PORTABILITY_SKIP_STAGES], report.stage, 'Only capability-probe or smoke may use bounded skipped; required stages must pass or fail.');
  }
  const capabilityError = validatePortabilityCapability(report.capability, report.terminalStatus, report.stage);
  if (capabilityError) return capabilityError;
  if (report.terminalStatus === 'skipped') {
    if (report.capability.result !== 'bounded-non-applicable') {
      return portabilityError('report-skipped-capability-invalid', 'bounded-non-applicable', report.capability.result, 'Use skipped only for an evidenced bounded capability limitation.');
    }
  }
  if (report.terminalStatus === 'failure' && !nonEmptyString(report.failureClass)) {
    return portabilityError('report-portability-failure-invalid', 'failure envelope for failed portability stage', report, 'Preserve the shared failureClass/code/expected/observed/hint envelope.');
  }
  const matrixError = validatePortabilityMatrix(report.matrix, report.sourceSha, report.platform);
  return matrixError ?? { ok: true };
}

function sameSet(left, right) {
  const leftValues = left instanceof Set ? [...left] : left;
  const rightValues = right instanceof Set ? [...right] : right;
  return Array.isArray(leftValues) && Array.isArray(rightValues)
    && leftValues.length === rightValues.length
    && new Set(leftValues).size === leftValues.length
    && new Set(rightValues).size === rightValues.length
    && leftValues.every((value) => rightValues.includes(value));
}

function validPlatformName(value) {
  return PORTABILITY_PLATFORMS.has(value);
}

function isLocalProfileReport(report) {
  return report.checkId === EDITOR_CI_LOCAL_PROFILE_CHECK_ID
    && ((report.profile === 'fast' && report.executionHome === 'local-fast')
      || (report.profile === 'full' && report.executionHome === 'local-full'));
}

export function validatePortabilityReport(report) {
  return report?.matrix?.kind === 'aggregate'
    ? validatePortabilityAggregateReport(report)
    : validatePortabilityStageReport(report);
}

export function projectEditorCiReport(envelope) {
  const report = {
    $schema: EDITOR_CI_REPORT_SCHEMA_VERSION,
    contractVersion: envelope?.contractVersion ?? null,
    checkId: envelope?.checkId ?? null,
    owner: envelope?.owner ?? null,
    profile: envelope?.profile ?? null,
    executionHome: envelope?.executionHome ?? null,
    terminalStatus: envelope?.terminalStatus ?? null,
    failureClass: envelope?.failureClass ?? null,
    code: envelope?.code ?? null,
    expected: envelope?.expected ?? null,
    observed: envelope?.observed ?? null,
    hint: envelope?.hint ?? null,
    firstFailure: envelope?.firstFailure ?? null,
    attempts: Array.isArray(envelope?.attempts) ? structuredClone(envelope.attempts) : [],
    provenance: isObject(envelope?.provenance) ? structuredClone(envelope.provenance) : envelope?.provenance ?? null,
    sloClaim: envelope?.sloClaim ?? null,
    prerequisiteRelease: isObject(envelope?.prerequisiteRelease)
      ? structuredClone(envelope.prerequisiteRelease)
      : envelope?.prerequisiteRelease ?? null,
  };
  if (envelope?.checkId === 'editor-portability') {
    for (const field of ['sourceSha', 'platform', 'stage', 'capability', 'matrix']) {
      if (Object.hasOwn(envelope, field)) report[field] = structuredClone(envelope[field]);
    }
  }
  return report;
}

function validateEditorCiReportBase(report) {
  if (!isObject(report)) return reportError('report-root-invalid', 'an object', report, 'Return one JSON report object.');
  for (const field of REPORT_FIELDS) {
    if (!Object.hasOwn(report, field)) {
      return reportError(
        field === 'prerequisiteRelease' ? 'report-prerequisite-release-missing' : 'report-field-missing',
        field,
        'missing',
        `Include ${field} in the JSON report.`,
      );
    }
  }
  for (const field of ['contractVersion', 'checkId', 'owner', 'profile', 'executionHome']) {
    const error = requiredString(report, field);
    if (error) return error;
  }
  if (report.checkId !== 'editor-portability' && !ORDINARY_CHECK_IDS.has(report.checkId) && !isLocalProfileReport(report)) {
    return reportError(
      'report-check-id-invalid',
      [...ORDINARY_CHECK_IDS, 'editor-portability', EDITOR_CI_LOCAL_PROFILE_CHECK_ID],
      report.checkId,
      'Use one ordinary checkId, the local aggregate ci-profile discriminator with its matching home, or the editor-portability discriminator.',
    );
  }
  if (!TERMINAL_STATUSES.has(report.terminalStatus)) {
    return reportError('report-terminal-status-invalid', [...TERMINAL_STATUSES], report.terminalStatus, 'Use pass, failure, or skipped.');
  }
  if (!isObject(report.provenance) || typeof report.provenance.kind !== 'string' || typeof report.provenance.timingDomain !== 'string') {
    return reportError('report-provenance-invalid', 'provenance.kind and provenance.timingDomain', report.provenance, 'Keep evidence origin and timing domain explicit.');
  }
  if (!Array.isArray(report.attempts) || report.attempts.length === 0) {
    return reportError('report-attempts-invalid', 'a non-empty attempts array', report.attempts, 'Preserve each execution attempt in the report.');
  }
  if (report.failureClass !== null && !FAILURE_CLASSES.has(report.failureClass)) {
    return reportError('report-failure-class-invalid', [...FAILURE_CLASSES], report.failureClass, 'Use the producer-owned failure class union.');
  }
  if (report.terminalStatus === 'failure') {
    for (const field of ['failureClass', 'code', 'expected', 'observed', 'hint']) {
      const error = requiredString(report, field);
      if (error) return error;
    }
    if (!isObject(report.firstFailure)) {
      return reportError('report-first-failure-invalid', 'an object', report.firstFailure, 'Preserve the first failed attempt as structured data.');
    }
  }
  if (report.sloClaim !== null && typeof report.sloClaim !== 'string') {
    return reportError('report-slo-claim-invalid', 'null or a string claim', report.sloClaim, 'Do not derive a cloud SLO from local duration.');
  }
  const prerequisiteError = validatePrerequisiteRelease(report.prerequisiteRelease);
  if (prerequisiteError) return prerequisiteError;
  return { ok: true };
}

export function validateEditorCiReport(report) {
  const baseValidation = validateEditorCiReportBase(report);
  if (!baseValidation.ok) return baseValidation;
  if (report.checkId === 'editor-portability') {
    const portabilityError = validatePortabilityReport(report);
    if (portabilityError) return portabilityError;
  }
  return { ok: true };
}

if (import.meta.main) {
  const input = await new Response(Bun.stdin).json();
  const report = projectEditorCiReport(input);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!validateEditorCiReport(report).ok) process.exitCode = 1;
}
