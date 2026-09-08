import type {
  CapabilityRegistration,
  CapabilitySchema,
} from './capability';

/**
 * Public renderer-owner admission is the evidence gate for renderer claims.
 *
 * Proposition: on one selected Studio `:18920` carrier, the renderer owner
 * must be identified before any renderer correction or acceptance decision.
 * Discovery: require `editor-transport/v1`, capability
 * `renderer.ownerAdmission`, `available: true`, and every declared
 * precondition. Dispatch: call the typed `run.dispatch` path with schema
 * `renderer-owner-admission/v1`; the only experiment variable is
 * `shadowSubmitMode`, either `independent` or `coalesced-with-frame`.
 * Recovery: branch on `code`, `category`, `phase`, `expected`, `observed`,
 * `hint`, `recoveryActions`, and `safeRerun`, then use
 * `renderer.ownerAdmission.rediscover` on a fresh carrier. Provenance is
 * report-level evidence and retains trace, raw-log, capture, and teardown
 * references. A direct engine endpoint or an undocumented alias is not a
 * valid fallback for this contract.
 */
export const RENDERER_OWNER_ADMISSION_SCHEMA = 'renderer-owner-admission/v1' as const;
export const RENDERER_OWNER_ADMISSION_OPERATION = 'renderer.ownerAdmission' as const;
export const RENDERER_OWNER_ADMISSION_RECOVERY = 'renderer.ownerAdmission.rediscover' as const;
export const RENDERER_OWNER_ADMISSION_OWNER = '@forgeax/engine-render' as const;

export const RENDERER_OWNER_ADMISSION_MODES = Object.freeze([
  'independent',
  'coalesced-with-frame',
] as const);

export const RENDERER_OWNER_ADMISSION_IDENTITY_FIELDS = Object.freeze([
  'carrierId',
  'pageIdentity',
  'browserRealmId',
  'runtimeId',
  'canvasIdentity',
  'rendererGeneration',
] as const);

export type RendererOwnerAdmissionMode = (typeof RENDERER_OWNER_ADMISSION_MODES)[number];

/** The complete identity tuple that must stay stable across the A/B pair. */
export interface RendererOwnerAdmissionIdentity {
  readonly carrierId: string;
  readonly pageIdentity: string;
  readonly browserRealmId: string;
  readonly runtimeId: string;
  readonly canvasIdentity: string;
  readonly rendererGeneration: string;
}

/**
 * Typed input for the public owner-admission operation. Discover the public
 * capability before dispatch; `operation` is optional for generic clients but
 * is canonical when present.
 */
export interface RendererOwnerAdmissionRequest {
  readonly schema: typeof RENDERER_OWNER_ADMISSION_SCHEMA;
  readonly operation?: typeof RENDERER_OWNER_ADMISSION_OPERATION;
  readonly shadowSubmitMode: RendererOwnerAdmissionMode;
  readonly identity: RendererOwnerAdmissionIdentity;
}

/** One renderer observation retained by an admitted public run. */
export interface RendererOwnerAdmissionObservation {
  readonly shadowSubmitMode: RendererOwnerAdmissionMode;
  readonly identity: RendererOwnerAdmissionIdentity;
  readonly rendererGeneration: string;
  readonly commandBuffers: readonly string[];
  readonly drawCaptureParity: boolean;
}

/**
 * Field-addressable failure returned when admission is blocked or
 * inconclusive. The surrounding Studio QA report adds teardown and evidence
 * provenance to this product-level failure.
 */
export interface RendererOwnerAdmissionFailure {
  readonly code: string;
  readonly category: string;
  readonly phase: string;
  readonly expected: unknown;
  readonly observed?: unknown;
  readonly hint: string;
  readonly recoveryActions: readonly [typeof RENDERER_OWNER_ADMISSION_RECOVERY];
  readonly safeRerun: boolean;
}

/**
 * Public result. Continue only for `admitted`, exact apply/restore counts of
 * one, non-null independent and coalesced observations, parity, and one
 * identity plus renderer generation. `blocked` and `inconclusive` never
 * unlock downstream renderer evidence.
 */
export interface RendererOwnerAdmissionResult {
  readonly status: 'admitted' | 'blocked' | 'inconclusive';
  readonly operation: typeof RENDERER_OWNER_ADMISSION_OPERATION;
  readonly identity: RendererOwnerAdmissionIdentity;
  readonly appliedCount: number;
  readonly restoredCount: number;
  readonly baseline: RendererOwnerAdmissionObservation | null;
  readonly ab: RendererOwnerAdmissionObservation | null;
  readonly drawCaptureParity: boolean | null;
  readonly evidenceSource: string;
  readonly publicUrl: string;
  readonly failure?: RendererOwnerAdmissionFailure;
}

/** Stable contract error returned by request/result validation. */
export interface RendererOwnerAdmissionContractError {
  readonly code: string;
  readonly category: string;
  readonly phase: string;
  readonly expected: unknown;
  readonly observed?: unknown;
  readonly hint: string;
  readonly retryable: false;
  readonly recoveryActions: readonly [typeof RENDERER_OWNER_ADMISSION_RECOVERY];
  readonly safeRerun: true;
}

export type RendererOwnerAdmissionValidation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RendererOwnerAdmissionContractError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isIdentity(value: unknown): value is RendererOwnerAdmissionIdentity {
  return isRecord(value) && RENDERER_OWNER_ADMISSION_IDENTITY_FIELDS.every((field) => isNonEmptyString(value[field]));
}

function failure(
  code: string,
  phase: string,
  expected: unknown,
  hint: string,
  observed?: unknown,
): { readonly ok: false; readonly error: RendererOwnerAdmissionContractError } {
  return {
    ok: false,
    error: {
      code,
      category: 'validation',
      phase,
      expected,
      ...(observed === undefined ? {} : { observed }),
      hint,
      retryable: false,
      recoveryActions: [RENDERER_OWNER_ADMISSION_RECOVERY],
      safeRerun: true,
    },
  };
}

function identityMismatch(observed: unknown): { readonly ok: false; readonly error: RendererOwnerAdmissionContractError } {
  return failure(
    'renderer-owner-admission-identity-mismatch',
    'discover',
    { identityFields: [...RENDERER_OWNER_ADMISSION_IDENTITY_FIELDS] },
    'The renderer carrier identity and generation must be complete and stable for this run.',
    observed,
  );
}

function sameIdentity(left: RendererOwnerAdmissionIdentity, right: RendererOwnerAdmissionIdentity): boolean {
  return RENDERER_OWNER_ADMISSION_IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}

function isMode(value: unknown): value is RendererOwnerAdmissionMode {
  return typeof value === 'string' && (RENDERER_OWNER_ADMISSION_MODES as readonly string[]).includes(value);
}

export function validateRendererOwnerAdmissionRequest(
  value: unknown,
): RendererOwnerAdmissionValidation<RendererOwnerAdmissionRequest> {
  if (!isRecord(value)) {
    return failure('renderer-owner-admission-invalid-request', 'discover', { schema: RENDERER_OWNER_ADMISSION_SCHEMA }, 'A typed renderer owner admission request is required.');
  }
  if (value.schema !== RENDERER_OWNER_ADMISSION_SCHEMA) {
    return failure('renderer-owner-admission-invalid-schema', 'discover', { schema: RENDERER_OWNER_ADMISSION_SCHEMA }, 'The renderer owner admission schema is not supported.', value.schema);
  }
  if (value.operation !== undefined && value.operation !== RENDERER_OWNER_ADMISSION_OPERATION) {
    return failure('renderer-owner-admission-invalid-operation', 'dispatch', { operation: RENDERER_OWNER_ADMISSION_OPERATION }, 'The renderer owner admission operation is not supported.', value.operation);
  }
  if (!isMode(value.shadowSubmitMode)) {
    return failure(
      'renderer-owner-admission-invalid-mode',
      'dispatch',
      { shadowSubmitMode: [...RENDERER_OWNER_ADMISSION_MODES] },
      'shadowSubmitMode must select one supported renderer submission mode.',
      value.shadowSubmitMode,
    );
  }
  if (!isIdentity(value.identity)) return identityMismatch(value.identity);
  return {
    ok: true,
    value: {
      schema: RENDERER_OWNER_ADMISSION_SCHEMA,
      ...(value.operation === undefined ? {} : { operation: RENDERER_OWNER_ADMISSION_OPERATION }),
      shadowSubmitMode: value.shadowSubmitMode,
      identity: { ...value.identity },
    },
  };
}

function isObservation(value: unknown): value is RendererOwnerAdmissionObservation {
  return isRecord(value) &&
    isMode(value.shadowSubmitMode) &&
    isIdentity(value.identity) &&
    value.rendererGeneration === value.identity.rendererGeneration &&
    Array.isArray(value.commandBuffers) &&
    value.commandBuffers.length > 0 &&
    value.commandBuffers.every(isNonEmptyString) &&
    value.drawCaptureParity === true;
}

function isFailure(value: unknown): value is RendererOwnerAdmissionFailure {
  return isRecord(value) &&
    isNonEmptyString(value.code) &&
    isNonEmptyString(value.category) &&
    isNonEmptyString(value.phase) &&
    isNonEmptyString(value.hint) &&
    Array.isArray(value.recoveryActions) &&
    value.recoveryActions.length === 1 &&
    value.recoveryActions[0] === RENDERER_OWNER_ADMISSION_RECOVERY &&
    value.safeRerun === true;
}

export function validateRendererOwnerAdmissionResult(
  value: unknown,
): RendererOwnerAdmissionValidation<RendererOwnerAdmissionResult> {
  if (!isRecord(value) || value.operation !== RENDERER_OWNER_ADMISSION_OPERATION || !isIdentity(value.identity)) {
    return failure('renderer-owner-admission-identity-mismatch', 'capture', { operation: RENDERER_OWNER_ADMISSION_OPERATION, identityFields: [...RENDERER_OWNER_ADMISSION_IDENTITY_FIELDS] }, 'The renderer owner admission result is missing its operation or identity.', value);
  }
  const identity = value.identity;
  if (value.status !== 'admitted' && value.status !== 'blocked' && value.status !== 'inconclusive') {
    return failure('renderer-owner-admission-incomplete', 'capture', { status: ['admitted', 'blocked', 'inconclusive'] }, 'The renderer owner admission result has an unsupported status.', value.status);
  }
  if (!Number.isInteger(value.appliedCount) || !Number.isInteger(value.restoredCount)) {
    return failure('renderer-owner-admission-incomplete', 'capture', { appliedCount: 'integer', restoredCount: 'integer' }, 'Renderer apply and restore counts must be integers.', { appliedCount: value.appliedCount, restoredCount: value.restoredCount });
  }
  if (value.status !== 'admitted') {
    if (!isFailure(value.failure) || value.baseline !== null || value.ab !== null || value.drawCaptureParity !== null || value.appliedCount !== 0 || value.restoredCount !== 0) {
      return failure('renderer-owner-admission-incomplete', 'capture', { status: value.status, failure: 'structured', counts: 0 }, 'Blocked or inconclusive renderer admission must remain an explicit structured failure.', value);
    }
    return { ok: true, value: value as unknown as RendererOwnerAdmissionResult };
  }
  if (value.failure !== undefined || value.appliedCount !== 1 || value.restoredCount !== 1 || value.drawCaptureParity !== true || value.evidenceSource !== 'public-studio-carrier' || value.publicUrl !== 'http://localhost:18920' || !isObservation(value.baseline) || !isObservation(value.ab)) {
    return failure('renderer-owner-admission-incomplete', 'capture', { appliedCount: 1, restoredCount: 1, publicEvidence: true, drawCaptureParity: true }, 'Admission requires public A/B evidence with exact apply and restore parity.', value);
  }
  const baseline = value.baseline;
  const ab = value.ab;
  if (!sameIdentity(identity, baseline.identity) || !sameIdentity(identity, ab.identity)) {
    return failure('renderer-owner-admission-identity-mismatch', 'capture', { rendererGeneration: identity.rendererGeneration }, 'Every renderer observation must use the same carrier identity and renderer generation.', value);
  }
  if (baseline.shadowSubmitMode !== 'independent' || ab.shadowSubmitMode !== 'coalesced-with-frame') {
    return failure('renderer-owner-admission-incomplete', 'capture', { baseline: 'independent', ab: 'coalesced-with-frame' }, 'Admission requires the independent baseline and coalesced A/B observations.', value);
  }
  return { ok: true, value: value as unknown as RendererOwnerAdmissionResult };
}

const identitySchema: CapabilitySchema = Object.freeze({
  type: 'object',
  required: [...RENDERER_OWNER_ADMISSION_IDENTITY_FIELDS],
  properties: Object.freeze(Object.fromEntries(RENDERER_OWNER_ADMISSION_IDENTITY_FIELDS.map((field) => [field, { type: 'string' as const }])) as Record<string, CapabilitySchema>),
});

export function createRendererOwnerAdmissionRegistration(): CapabilityRegistration {
  const capabilityGeneration = RENDERER_OWNER_ADMISSION_SCHEMA;
  return {
    id: RENDERER_OWNER_ADMISSION_OPERATION,
    kind: 'run',
    version: '1',
    subject: 'renderer',
    verb: 'ownerAdmission',
    capabilityGeneration,
    stage: 'discover',
    owner: RENDERER_OWNER_ADMISSION_OWNER,
    inputSchema: {
      type: 'object',
      required: ['schema', 'shadowSubmitMode', 'identity'],
      properties: {
        schema: { type: 'string', enum: [RENDERER_OWNER_ADMISSION_SCHEMA] },
        operation: { type: 'string', enum: [RENDERER_OWNER_ADMISSION_OPERATION] },
        shadowSubmitMode: { type: 'string', enum: [...RENDERER_OWNER_ADMISSION_MODES] },
        identity: identitySchema,
      },
    },
    outputSchema: {
      type: 'object',
      required: ['status', 'operation', 'identity', 'appliedCount', 'restoredCount', 'baseline', 'ab', 'drawCaptureParity', 'evidenceSource', 'publicUrl'],
      properties: {
        status: { type: 'string', enum: ['admitted', 'blocked', 'inconclusive'] },
        operation: { type: 'string', enum: [RENDERER_OWNER_ADMISSION_OPERATION] },
        identity: identitySchema,
        appliedCount: { type: 'number' },
        restoredCount: { type: 'number' },
        baseline: { type: 'object' },
        ab: { type: 'object' },
        drawCaptureParity: { type: 'boolean' },
        evidenceSource: { type: 'string' },
        publicUrl: { type: 'string' },
        failure: { type: 'object' },
      },
    },
    availability: {
      available: false,
      code: 'capability-blocked',
      reason: 'The renderer owner-admission adapter is unavailable on the selected public carrier.',
      resolution: 'Stop the selected public run, rediscover the capability, and retry on one fresh carrier.',
      capabilityGeneration,
      stage: 'discover',
      owner: RENDERER_OWNER_ADMISSION_OWNER,
      expected: RENDERER_OWNER_ADMISSION_OPERATION,
      recoveryAction: RENDERER_OWNER_ADMISSION_RECOVERY,
      diagnosticId: 'renderer-owner-admission-adapter-unavailable',
    },
    preconditions: Object.freeze([
      'public-carrier-selected',
      'renderer-identity-bound',
      'renderer-generation-stable',
      'renderer-owner-adapter-available',
    ]),
    permission: { scope: 'renderer', action: 'execute' },
    cancellation: { supported: false, reason: 'Renderer owner admission is bounded to one carrier run.' },
    retry: { supported: true, createsNewAttempt: true },
    recoveryActions: Object.freeze([RENDERER_OWNER_ADMISSION_RECOVERY]),
    recoveryAction: RENDERER_OWNER_ADMISSION_RECOVERY,
    diagnosticId: 'renderer-owner-admission-adapter-unavailable',
  };
}
