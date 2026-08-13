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

function reportError(code, expected, observed, hint) {
  return { ok: false, error: { code, expected, observed, hint } };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
  return report;
}

export function validateEditorCiReport(report) {
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

if (import.meta.main) {
  const input = await new Response(Bun.stdin).json();
  const report = projectEditorCiReport(input);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!validateEditorCiReport(report).ok) process.exitCode = 1;
}
