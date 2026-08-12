import { createHash } from 'node:crypto';

const FAILURE_CLASSES = new Set(['admission', 'environment', 'source', 'external-transport']);
const TERMINAL_STATUSES = new Set(['pass', 'failure', 'skipped']);

export const ADMISSION_SCHEMA_VERSION = 'forgeax-editor-ci-admission/v1';
export const ADMISSION_ENVELOPE_FIELDS = [
  'schemaVersion',
  'immutable',
  'generation',
  'remoteMainSha',
  'candidateSourceSha',
  'sourceSha',
  'submodulePins',
  'contractDigest',
  'workflowDigest',
  'sourceBaseline',
  'producerOwnership',
  'provenance',
  'admissionDigest',
];

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export const LANDED_REQUIRED_CONTEXTS = [
  'b2-self-boot',
  'typecheck',
  'submodule-pin',
  'smoke-play',
];

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

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digestAdmissionValue(value) {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

function admissionIssue(code, expected, observed, hint) {
  return { code, expected, observed, hint };
}

function blockedHandoff(error, blocker, owner, requiredEvidence, nextAction) {
  return {
    ok: false,
    status: 'blocked',
    error,
    handoff: { blocker, owner, requiredEvidence, nextAction },
  };
}

function deliveryHandoff(status, error, blocker, owner, requiredEvidence, nextAction, extra = {}) {
  return {
    ok: status === 'pass',
    status,
    error,
    handoff: { blocker, owner, requiredEvidence, nextAction },
    ...extra,
  };
}

function deliveryIssue(code, expected, observed, hint) {
  return { code, expected, observed, hint };
}

function deliveryPending(code, expected, observed, hint, blocker, requiredEvidence, nextAction) {
  return deliveryHandoff(
    'pending',
    deliveryIssue(code, expected, observed, hint),
    blocker,
    'release owner',
    requiredEvidence,
    nextAction,
  );
}

function deliveryNonpass(code, expected, observed, hint, blocker, requiredEvidence, nextAction) {
  return deliveryHandoff(
    'nonpass',
    deliveryIssue(code, expected, observed, hint),
    blocker,
    'release owner',
    requiredEvidence,
    nextAction,
  );
}

function validSha(value) {
  return typeof value === 'string' && SHA1.test(value);
}

function validateRemoteMainEvidence(input, landedSha) {
  const remoteMain = input?.remoteMain;
  if (!isObject(remoteMain)) {
    return deliveryPending(
      'landed-remote-main-evidence-missing',
      'remoteMain contains an observed remote-main SHA and ancestry proof',
      remoteMain ?? 'missing',
      'Read origin/main and prove the landed SHA is an ancestor with Git; PR state is not a substitute.',
      'remote-main ancestry evidence is missing',
      ['remote main SHA', 'landed SHA ancestry proof from origin/main'],
      'Fetch the current remote main and record a git merge-base --is-ancestor result for the landed SHA.',
    );
  }
  if (!validSha(remoteMain.sha) || !validSha(remoteMain.ancestorSha)) {
    return deliveryNonpass(
      'landed-remote-main-evidence-invalid',
      {sha: '40-character lowercase SHA', ancestorSha: landedSha},
      remoteMain,
      'Record immutable remote-main and ancestor SHAs from Git.',
      'remote-main ancestry evidence is malformed',
      ['remote main SHA', 'landed SHA ancestry proof'],
      'Re-run the remote-main ancestry check and preserve its exact SHA inputs.',
    );
  }
  if (remoteMain.ancestorSha !== landedSha || remoteMain.ancestor !== true || remoteMain.method !== 'git-merge-base-is-ancestor' || remoteMain.source !== 'remote-main' || remoteMain.repository !== 'origin') {
    return deliveryNonpass(
      'landed-remote-main-ancestry-invalid',
      {ancestorSha: landedSha, ancestor: true, method: 'git-merge-base-is-ancestor', source: 'remote-main', repository: 'origin'},
      remoteMain,
      'Only an explicit origin/main ancestry proof for the exact landed SHA can establish landing.',
      'remote main does not prove the landed SHA is present',
      ['origin/main SHA', 'git merge-base --is-ancestor evidence'],
      'Recompute ancestry for the exact merge SHA; do not use commit counts or PR labels.',
    );
  }
  return null;
}

function validateSingleLandedContext(context, landedSha, requiredContexts, seen) {
  if (!isObject(context) || typeof context.context !== 'string') {
    return deliveryNonpass(
      'landed-required-context-invalid',
      'context records with context, SHA, conclusion, and cloud provenance',
      context,
      'Preserve one structured cloud evidence record per required context.',
      'a landed required context record is malformed',
      requiredContexts,
      'Fetch structured check-run evidence instead of parsing a human log.',
    );
  }
  if (!requiredContexts.includes(context.context)) {
    return deliveryNonpass(
      'landed-required-context-unexpected',
      requiredContexts,
      context.context,
      'Reject checks outside the existing four required contexts.',
      'an unexpected required context was supplied',
      requiredContexts,
      'Use the producer contract requiredContexts mapping without adding a parallel parent.',
    );
  }
  if (seen.has(context.context)) {
    return deliveryNonpass(
      'landed-required-context-duplicate',
      'one evidence record per required context',
      context.context,
      'Do not collapse or duplicate required contexts when projecting landed evidence.',
      `${context.context} has duplicate landed evidence`,
      requiredContexts,
      'Keep exactly one cloud result for each required context on the landed SHA.',
    );
  }
  seen.add(context.context);
  if (context.sha !== landedSha) {
    return deliveryNonpass(
      'landed-context-sha-mismatch',
      landedSha,
      context.sha,
      'Every required context must report the exact landed SHA.',
      `${context.context} belongs to a different SHA`,
      [`${context.context} on ${landedSha}`],
      'Query or rerun the context for the exact landed SHA; do not mix PR and post-merge results.',
    );
  }
  if (context.conclusion !== 'success') {
    return deliveryNonpass(
      'landed-context-nonpass',
      'success',
      context.conclusion,
      'A non-success landed context keeps delivery nonpass.',
      `${context.context} did not pass on the landed SHA`,
      [`${context.context} conclusion=success on ${landedSha}`],
      'Resolve the failed post-merge context and collect a new exact-SHA result.',
    );
  }
  if (context.provenance?.kind !== 'cloud' || context.provenance?.timingDomain !== 'workflow-execution') {
    return deliveryNonpass(
      'landed-context-provenance-invalid',
      {kind: 'cloud', timingDomain: 'workflow-execution'},
      context.provenance ?? 'missing',
      'Local, PR-only, and historical results cannot be promoted to landed evidence.',
      `${context.context} is not backed by post-merge cloud evidence`,
      [`cloud ${context.context} result on ${landedSha}`],
      'Obtain the post-merge workflow result for this exact SHA; do not relabel local output.',
    );
  }
  return null;
}

function validateLandedContextEvidence(contexts, landedSha, requiredContexts) {
  if (!Array.isArray(contexts) || contexts.length === 0) {
    return deliveryPending(
      'landed-required-contexts-missing',
      requiredContexts,
      contexts ?? 'missing',
      'Read cloud check runs for the exact landed SHA; local green and PR checks do not satisfy landed contexts.',
      'landed required contexts are missing',
      requiredContexts.map((context) => `${context} on ${landedSha}`),
      'Query the post-merge required contexts for the exact landed SHA and record all four results.',
    );
  }
  const seen = new Set();
  for (const context of contexts) {
    const issue = validateSingleLandedContext(context, landedSha, requiredContexts, seen);
    if (issue) return issue;
  }
  const missing = requiredContexts.filter((context) => !seen.has(context));
  if (missing.length > 0 || contexts.length !== requiredContexts.length) {
    return deliveryPending(
      'landed-required-contexts-missing',
      requiredContexts,
      {contexts: contexts.map((context) => context?.context ?? null), missing},
      'The landed result must contain exactly the four producer-required contexts.',
      'the landed required context set is incomplete',
      missing.map((context) => `${context} on ${landedSha}`),
      'Query the missing exact-SHA contexts and preserve one record for each required context.',
    );
  }
  return null;
}

export function validateLandedDelivery(input, {requiredContexts = LANDED_REQUIRED_CONTEXTS} = {}) {
  if (!isObject(input) || !validSha(input.landedSha)) {
    return deliveryPending(
      'landed-sha-missing',
      'landedSha is an immutable 40-character SHA',
      input?.landedSha ?? 'missing',
      'A merge SHA must be selected before checking remote ancestry or landed contexts.',
      'the landed merge SHA is missing',
      ['editor merge SHA'],
      'Obtain the actual merge SHA from the editor repository before querying delivery evidence.',
    );
  }
  if (!Array.isArray(requiredContexts) || requiredContexts.length !== LANDED_REQUIRED_CONTEXTS.length || new Set(requiredContexts).size !== requiredContexts.length || requiredContexts.some((context) => !LANDED_REQUIRED_CONTEXTS.includes(context))) {
    return deliveryNonpass(
      'landed-required-context-contract-invalid',
      LANDED_REQUIRED_CONTEXTS,
      requiredContexts,
      'The landed verifier may only use the existing four required contexts.',
      'required context projection is not the producer contract set',
      LANDED_REQUIRED_CONTEXTS,
      'Restore the existing required context projection before evaluating landed delivery.',
    );
  }
  const remoteIssue = validateRemoteMainEvidence(input, input.landedSha);
  if (remoteIssue) return remoteIssue;
  const contextIssue = validateLandedContextEvidence(input.contexts, input.landedSha, requiredContexts);
  if (contextIssue) return contextIssue;
  return {
    ok: true,
    status: 'pass',
    landedSha: input.landedSha,
    remoteMainSha: input.remoteMain.sha,
    requiredContexts: [...requiredContexts],
    contextEvidence: structuredClone(input.contexts),
  };
}

function validateDeliveryDigest(value, field) {
  if (field.endsWith('Sha')) return validSha(value);
  return typeof value === 'string' && SHA256.test(value);
}

export function validateAdmissionDelivery(input) {
  const admission = input?.admission;
  if (!isObject(admission)) {
    return deliveryPending(
      'delivery-admission-missing',
      'admission contains source SHA, generation, admission digest, and contract digest',
      admission ?? 'missing',
      'Delivery evidence must be bound to the immutable admission snapshot.',
      'admission evidence is missing',
      ['admission source SHA', 'admission generation', 'admission digest', 'contract digest'],
      'Read the current admission envelope and attach its immutable digest fields.',
    );
  }
  const required = [
    ['sourceSha', 'sourceSha'],
    ['remoteMainSha', 'remoteMainSha'],
    ['generation', 'generation'],
    ['admissionDigest', 'admissionDigest'],
    ['contractDigest', 'contractDigest'],
  ];
  for (const [field, digestField] of required) {
    const valid = field === 'generation'
      ? Number.isInteger(admission[field]) && admission[field] > 0
      : validateDeliveryDigest(admission[field], digestField);
    if (!valid) {
      return deliveryPending(
        `delivery-${field}-invalid`,
        field === 'generation' ? 'a positive integer generation' : `${field} is an immutable digest or SHA`,
        admission[field] ?? 'missing',
        'Recreate delivery evidence from the immutable admission envelope instead of filling a placeholder.',
        `admission ${field} is missing or malformed`,
        [field],
        `Read ${field} from the admitted source and recreate the delivery evidence.`,
      );
    }
  }
  for (const [observedField, admissionField] of [
    ['sourceSha', 'sourceSha'],
    ['remoteMainSha', 'remoteMainSha'],
    ['admissionGeneration', 'generation'],
    ['admissionDigest', 'admissionDigest'],
    ['contractDigest', 'contractDigest'],
  ]) {
    if (input[observedField] !== undefined && input[observedField] !== admission[admissionField]) {
      return deliveryNonpass(
        'delivery-admission-digest-drift',
        {[observedField]: admission[admissionField]},
        {[observedField]: input[observedField]},
        'Source and admission observations must match one immutable admission snapshot.',
        `${observedField} differs from the admitted snapshot`,
        [admissionField, observedField],
        'Discard the mixed-generation result and regenerate delivery evidence from one admission.',
      );
    }
  }
  return {
    ok: true,
    status: 'pass',
    sourceSha: admission.sourceSha,
    remoteMainSha: admission.remoteMainSha,
    generation: admission.generation,
    admissionDigest: admission.admissionDigest,
    contractDigest: admission.contractDigest,
  };
}

function decisionIssue(decision, field, code) {
  if (!isObject(decision) || decision.status !== 'approved' || decision.owner !== 'human') {
    return blockedHandoff(
      admissionIssue(
        code,
        { status: 'approved', owner: 'human', field },
        decision ?? 'missing',
        `Record the human ${field} decision before creating an admission pass envelope.`,
      ),
      `${field} decision is unresolved`,
      'human release owner',
      [`approved ${field} decision`, 'decision ID', 'decision evidence'],
      `Obtain and record the human ${field} decision, then create a new admission generation.`,
    );
  }
  if (typeof decision.decisionId !== 'string' || decision.decisionId.length === 0) {
    return blockedHandoff(
      admissionIssue(
        `${code}-evidence-missing`,
        `${field}.decisionId is present`,
        decision,
        `Attach a stable human decision ID for ${field}.`,
      ),
      `${field} decision lacks identity`,
      'human release owner',
      [`${field}.decisionId`, 'decision evidence'],
      `Add the human decision ID and recreate the admission envelope.`,
    );
  }
  if (!Array.isArray(decision.requiredEvidence) || decision.requiredEvidence.length === 0) {
    return blockedHandoff(
      admissionIssue(
        `${code}-evidence-missing`,
        `${field}.requiredEvidence is a non-empty array`,
        decision.requiredEvidence ?? 'missing',
        `Attach the evidence that supports the human ${field} decision.`,
      ),
      `${field} decision lacks evidence`,
      'human release owner',
      [`${field}.requiredEvidence`],
      `Record the evidence supporting the human decision and recreate the admission envelope.`,
    );
  }
  return null;
}

function validateSha(value, field) {
  return SHA1.test(value) ? null : admissionIssue(
    `${field}-invalid`,
    `${field} is a 40-character lowercase SHA`,
    value,
    `Record the immutable ${field} from Git before admission.`,
  );
}

function validateDigest(value, field) {
  return SHA256.test(value) ? null : admissionIssue(
    `${field}-invalid`,
    `${field} is a 64-character lowercase SHA-256 digest`,
    value,
    `Recompute the ${field} from the admitted content.`,
  );
}

function validateSubmodulePins(pins) {
  if (!Array.isArray(pins) || pins.length === 0) {
    return admissionIssue('submodule-pins-missing', 'a non-empty recursive submodule pin list', pins, 'Record every initialized recursive submodule pin before admission.');
  }
  const paths = new Set();
  for (const pin of pins) {
    if (!isObject(pin) || typeof pin.path !== 'string' || validateSha(pin.sha, 'submodule-pin')) {
      return admissionIssue('submodule-pin-invalid', 'each pin has a path and 40-character SHA', pin, 'Read recursive submodule status and record path/SHA pairs.');
    }
    if (paths.has(pin.path)) return admissionIssue('submodule-pin-duplicate', 'unique submodule paths', pin.path, 'Keep one recursive pin per submodule path.');
    paths.add(pin.path);
  }
  return null;
}

function historyContainsSha(provenance, sha) {
  return provenance?.historicalBranches?.some((branch) => branch?.sha === sha) ?? false;
}

function validateAdmissionInput(input) {
  const sourceDecision = decisionIssue(input.sourceBaseline, 'source baseline', 'source-baseline-unresolved');
  if (sourceDecision) return sourceDecision;
  const ownershipDecision = decisionIssue(input.producerOwnership, 'producer ownership', 'producer-ownership-unresolved');
  if (ownershipDecision) return ownershipDecision;
  for (const [field, value] of Object.entries({
    remoteMainSha: input.remoteMainSha,
    candidateSourceSha: input.candidateSourceSha,
    sourceSha: input.sourceSha,
  })) {
    const shaIssue = validateSha(value, field);
    if (shaIssue) return blockedHandoff(shaIssue, `${field} is not immutable`, 'release owner', [`${field} from Git`], `Read the current ${field} and create a new admission generation.`);
  }
  if (input.sourceBaseline.selectedSha !== input.candidateSourceSha) {
    return blockedHandoff(
      admissionIssue('source-baseline-mismatch', input.candidateSourceSha, input.sourceBaseline.selectedSha, 'Select the candidate source SHA explicitly; do not infer it from a historical branch.'),
      'source baseline does not identify the candidate source',
      'human release owner',
      ['human source baseline decision', 'candidate source SHA'],
      'Resolve the source baseline and create a new admission generation.',
    );
  }
  if (input.sourceSha !== input.candidateSourceSha) {
    return blockedHandoff(
      admissionIssue('source-candidate-mismatch', input.candidateSourceSha, input.sourceSha, 'Bind sourceSha to the selected candidate source SHA.'),
      'source SHA differs from candidate source SHA',
      'release owner',
      ['candidate source SHA', 'source checkout SHA'],
      'Reconcile the source checkout and recreate the admission envelope.',
    );
  }
  if (historyContainsSha(input.provenance, input.sourceSha)) {
    return blockedHandoff(
      admissionIssue('historical-source-not-current', 'source baseline is not a historical provenance SHA', input.sourceSha, 'Historical branches remain provenance context and cannot become the current source baseline.'),
      'historical branch was selected as current source',
      'human release owner',
      ['current candidate source decision', 'current source ancestry evidence'],
      'Select a current candidate source and create a new admission generation.',
    );
  }
  if (!Number.isInteger(input.generation) || input.generation < 1) {
    return blockedHandoff(admissionIssue('admission-generation-invalid', 'a positive integer generation', input.generation, 'Start each immutable admission with a positive generation.'), 'admission generation is invalid', 'release owner', ['generation record'], 'Choose the next admission generation.');
  }
  const submoduleIssue = validateSubmodulePins(input.submodulePins);
  if (submoduleIssue) return blockedHandoff(submoduleIssue, 'recursive submodule pins are incomplete', 'release owner', ['recursive submodule status'], 'Materialize and record all recursive submodule pins.');
  for (const [field, value] of [['contractDigest', input.contractDigest], ['workflowDigest', input.workflowDigest]]) {
    const digestIssue = validateDigest(value, field);
    if (digestIssue) return blockedHandoff(digestIssue, `${field} is not immutable`, 'release owner', [`${field} from admitted content`], `Recompute ${field} and create a new admission generation.`);
  }
  if (!isObject(input.provenance) || !Array.isArray(input.provenance.historicalBranches)) {
    return blockedHandoff(admissionIssue('provenance-missing', 'provenance.historicalBranches is an array', input.provenance, 'Retain historical branches as explicitly labeled provenance context.'), 'provenance is incomplete', 'release owner', ['historical branch references'], 'Record historical context without promoting it to current evidence.');
  }
  const invalidHistory = input.provenance.historicalBranches.find((branch) => branch?.role !== 'provenance-only');
  if (invalidHistory) return blockedHandoff(admissionIssue('historical-provenance-role-invalid', 'every historical branch has role provenance-only', invalidHistory, 'Keep historical branches as context only.'), 'historical branch role is not provenance-only', 'release owner', ['provenance-only labels'], 'Relabel historical context and create a new admission generation.');
  return null;
}

export function createAdmissionEnvelope(input) {
  const issueResult = validateAdmissionInput(input ?? {});
  if (issueResult) return issueResult;
  const material = {
    schemaVersion: ADMISSION_SCHEMA_VERSION,
    immutable: true,
    generation: input.generation,
    remoteMainSha: input.remoteMainSha,
    candidateSourceSha: input.candidateSourceSha,
    sourceSha: input.sourceSha,
    submodulePins: [...input.submodulePins].sort((left, right) => left.path.localeCompare(right.path)),
    contractDigest: input.contractDigest,
    workflowDigest: input.workflowDigest,
    sourceBaseline: structuredClone(input.sourceBaseline),
    producerOwnership: structuredClone(input.producerOwnership),
    provenance: structuredClone(input.provenance),
  };
  const envelope = { ...material, admissionDigest: digestAdmissionValue(material) };
  return { ok: true, status: 'pass', envelope };
}

function compareAdmissionField(expected, observed, field, code, hint) {
  if (canonicalize(expected) === canonicalize(observed)) return null;
  return admissionIssue(code, expected, observed, hint);
}

function validateAdmissionShape(envelope) {
  for (const field of ADMISSION_ENVELOPE_FIELDS) {
    if (!hasOwn(envelope, field)) return admissionIssue('admission-field-missing', field, 'missing', `Include ${field} in the immutable admission envelope.`);
  }
  if (envelope.schemaVersion !== ADMISSION_SCHEMA_VERSION) return admissionIssue('admission-schema-invalid', ADMISSION_SCHEMA_VERSION, envelope.schemaVersion, 'Use the supported immutable admission schema.');
  return null;
}

export function validateAdmissionEnvelope(expected, observed = expected) {
  if (!isObject(expected) || !isObject(observed)) {
    return { ok: false, error: admissionIssue('admission-envelope-type-invalid', 'an admission envelope object', observed, 'Pass one immutable admission envelope object.') };
  }
  const expectedShapeIssue = validateAdmissionShape(expected);
  if (expectedShapeIssue) return { ok: false, error: expectedShapeIssue };
  const observedShapeIssue = validateAdmissionShape(observed);
  if (observedShapeIssue) return { ok: false, error: observedShapeIssue };
  if (expected.immutable !== true || observed.immutable !== true) {
    return { ok: false, error: admissionIssue('admission-not-immutable', true, observed.immutable, 'Only immutable admission envelopes can be consumed by later milestones.') };
  }
  const fields = [
    ['schemaVersion', 'admission-schema-drift', 'Keep the supported admission schema version.'],
    ['remoteMainSha', 'remote-main-drift', 'Re-admit against the observed remote main SHA; do not follow moving main.'],
    ['candidateSourceSha', 'candidate-source-drift', 'Re-admit the selected candidate source SHA.'],
    ['sourceSha', 'source-drift', 'Use evidence from the admitted source checkout.'],
    ['submodulePins', 'submodule-pin-drift', 'Re-admit after recursively pinning the observed submodules.'],
    ['contractDigest', 'contract-digest-drift', 'Recompute the contract digest and create a new admission generation.'],
    ['workflowDigest', 'workflow-digest-drift', 'Recompute the workflow digest and create a new admission generation.'],
    ['generation', 'admission-generation-drift', 'Do not mix artifacts from different admission generations.'],
    ['sourceBaseline', 'source-baseline-drift', 'Use the human-approved source baseline bound to this admission.'],
    ['producerOwnership', 'producer-ownership-drift', 'Use the producer ownership decision bound to this admission.'],
  ];
  for (const [field, code, hint] of fields) {
    const issueResult = compareAdmissionField(expected[field], observed[field], field, code, hint);
    if (issueResult) return { ok: false, error: issueResult };
  }
  if (observed.admissionDigest !== expected.admissionDigest) {
    return { ok: false, error: admissionIssue('admission-digest-drift', expected.admissionDigest, observed.admissionDigest, 'Do not consume an envelope whose immutable digest differs from the admitted snapshot.') };
  }
  const material = { ...observed };
  delete material.admissionDigest;
  if (digestAdmissionValue(material) !== observed.admissionDigest) {
    return { ok: false, error: admissionIssue('admission-digest-invalid', digestAdmissionValue(material), observed.admissionDigest, 'Recreate the envelope instead of editing an admitted snapshot.') };
  }
  return { ok: true, envelope: observed };
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
