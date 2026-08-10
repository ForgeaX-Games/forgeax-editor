const FAILURE_CLASSES = new Set(['admission', 'environment', 'source', 'external-transport']);
const TERMINAL_STATUSES = new Set(['pass', 'failure', 'skipped']);

export const ENVELOPE_FIELDS = [
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
];

function envelopeIssue(code, expected, observed, hint) {
  return { code, expected, observed, hint };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function normalizeEnvelope(input) {
  const envelope = {};
  for (const field of ENVELOPE_FIELDS) envelope[field] = input[field] ?? null;
  envelope.attempts = Array.isArray(input.attempts) ? structuredClone(input.attempts) : [];
  envelope.provenance = isObject(input.provenance) ? structuredClone(input.provenance) : input.provenance;
  envelope.firstFailure = input.firstFailure === undefined ? null : structuredClone(input.firstFailure);
  envelope.sloClaim = input.sloClaim ?? null;
  return envelope;
}

function validateAttempt(attempt, index) {
  if (!isObject(attempt)) {
    return envelopeIssue('attempt-type-invalid', `attempts[${index}] is an object`, typeof attempt, `Keep attempts[${index}] as an attempt record.`);
  }
  for (const field of ['attempt', 'attemptId', 'status']) {
    if (!hasOwn(attempt, field)) {
      return envelopeIssue('attempt-field-missing', `${field} is present`, 'missing', `Record ${field} for attempts[${index}].`);
    }
  }
  if (!Number.isInteger(attempt.attempt) || attempt.attempt < 1) {
    return envelopeIssue('attempt-number-invalid', 'a positive integer', attempt.attempt, `Use a positive attempt number for attempts[${index}].`);
  }
  if (typeof attempt.attemptId !== 'string' || attempt.attemptId.length === 0) {
    return envelopeIssue('attempt-identity-invalid', 'a non-empty attemptId', attempt.attemptId, `Give attempts[${index}] a stable identity.`);
  }
  return null;
}

function validateFirstFailure(firstFailure) {
  if (!isObject(firstFailure)) {
    return envelopeIssue('first-failure-invalid', 'an object', firstFailure, 'Preserve the first failed attempt as a structured object.');
  }
  for (const field of ['attempt', 'attemptId', 'code', 'expected', 'observed']) {
    if (!hasOwn(firstFailure, field)) {
      return envelopeIssue('first-failure-field-missing', field, 'missing', `Preserve ${field} in firstFailure.`);
    }
  }
  return null;
}

export function validateEnvelope(envelope) {
  if (!isObject(envelope)) {
    return { ok: false, error: envelopeIssue('envelope-root-type', 'an object', typeof envelope, 'Return one JSON result envelope object.') };
  }
  for (const field of ENVELOPE_FIELDS) {
    if (!hasOwn(envelope, field)) {
      return { ok: false, error: envelopeIssue('envelope-field-missing', field, 'missing', `Include ${field} in every terminal result envelope.`) };
    }
  }
  for (const field of ['checkId', 'owner', 'profile', 'executionHome']) {
    if (typeof envelope[field] !== 'string' || envelope[field].length === 0) {
      return { ok: false, error: envelopeIssue('envelope-field-invalid', `non-empty ${field}`, envelope[field], `Set ${field} from the contract identity.`) };
    }
  }
  if (!isObject(envelope.provenance)) {
    return { ok: false, error: envelopeIssue('provenance-invalid', 'an object', envelope.provenance, 'Record provenance and timing domain separately from check duration.') };
  }
  if (typeof envelope.provenance.kind !== 'string' || typeof envelope.provenance.timingDomain !== 'string') {
    return { ok: false, error: envelopeIssue('provenance-field-missing', 'kind and timingDomain strings', envelope.provenance, 'Distinguish local evidence from cloud workflow evidence.') };
  }
  if (!TERMINAL_STATUSES.has(envelope.terminalStatus)) {
    return { ok: false, error: envelopeIssue('terminal-status-invalid', [...TERMINAL_STATUSES].join(', '), envelope.terminalStatus, 'Use a supported terminal status.') };
  }
  if (envelope.failureClass !== null && !FAILURE_CLASSES.has(envelope.failureClass)) {
    return { ok: false, error: envelopeIssue('failure-class-invalid', [...FAILURE_CLASSES].join(', '), envelope.failureClass, 'Use one of the four closed failure classes.') };
  }
  if (envelope.terminalStatus === 'failure') {
    for (const field of ['failureClass', 'code', 'expected', 'observed', 'hint']) {
      if (typeof envelope[field] !== 'string' || envelope[field].length === 0) {
        return { ok: false, error: envelopeIssue('failure-field-missing', field, envelope[field], `Provide ${field} so an AI user can choose a recovery action.`) };
      }
    }
    const firstFailureIssue = validateFirstFailure(envelope.firstFailure);
    if (firstFailureIssue) return { ok: false, error: firstFailureIssue };
  }
  if (!Array.isArray(envelope.attempts) || envelope.attempts.length === 0) {
    return { ok: false, error: envelopeIssue('attempts-missing', 'a non-empty attempts array', envelope.attempts, 'Record every attempt identity, including the first failure.') };
  }
  const attemptIds = new Set();
  for (const [index, attempt] of envelope.attempts.entries()) {
    const attemptIssue = validateAttempt(attempt, index);
    if (attemptIssue) return { ok: false, error: attemptIssue };
    if (attemptIds.has(attempt.attemptId)) {
      return { ok: false, error: envelopeIssue('attempt-identity-duplicate', 'unique attemptId values', attempt.attemptId, 'Give each retry a distinct attempt identity.') };
    }
    attemptIds.add(attempt.attemptId);
  }
  if (envelope.terminalStatus !== 'failure' && envelope.failureClass !== null) {
    return { ok: false, error: envelopeIssue('failure-class-without-failure', 'null failureClass for a non-failure result', envelope.failureClass, 'Only classify a failure when terminalStatus is failure.') };
  }
  return { ok: true };
}

export function planRetry(envelope) {
  const eligible = envelope.failureClass === 'external-transport'
    && envelope.attempts?.[0]?.transient === true;
  const maxAttempts = eligible ? 2 : 1;
  return {
    retry: eligible && envelope.attempts.length < maxAttempts,
    maxAttempts,
    reason: eligible ? 'transient external transport evidence' : 'failure class is not retryable',
  };
}
