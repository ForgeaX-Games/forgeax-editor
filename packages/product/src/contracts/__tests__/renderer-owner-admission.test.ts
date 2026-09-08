import { expect, test } from 'bun:test';

import {
  RENDERER_OWNER_ADMISSION_OPERATION,
  RENDERER_OWNER_ADMISSION_SCHEMA,
  validateRendererOwnerAdmissionRequest,
  validateRendererOwnerAdmissionResult,
  type RendererOwnerAdmissionRequest,
  type RendererOwnerAdmissionResult,
} from '../renderer-owner-admission';

const identity = {
  carrierId: 'studio-carrier-1',
  pageIdentity: 'page-1',
  browserRealmId: 'realm-1',
  runtimeId: 'runtime-1',
  canvasIdentity: 'canvas-1',
  rendererGeneration: 'renderer-generation-1',
} as const;

const validRequest: RendererOwnerAdmissionRequest = {
  schema: RENDERER_OWNER_ADMISSION_SCHEMA,
  operation: RENDERER_OWNER_ADMISSION_OPERATION,
  shadowSubmitMode: 'coalesced-with-frame',
  identity,
};

const observation = (shadowSubmitMode: 'independent' | 'coalesced-with-frame') => ({
  shadowSubmitMode,
  identity,
  rendererGeneration: identity.rendererGeneration,
  commandBuffers: shadowSubmitMode === 'independent'
    ? ['shadow-1', 'shadow-2']
    : ['shadow-1', 'shadow-2', 'frame-final'],
  drawCaptureParity: true,
});

const admittedResult: RendererOwnerAdmissionResult = {
  status: 'admitted',
  operation: RENDERER_OWNER_ADMISSION_OPERATION,
  identity,
  appliedCount: 1,
  restoredCount: 1,
  baseline: observation('independent'),
  ab: observation('coalesced-with-frame'),
  drawCaptureParity: true,
  evidenceSource: 'public-studio-carrier',
  publicUrl: 'http://localhost:18920',
};

test('renderer owner request is a public typed contract with full identity', () => {
  expect(validateRendererOwnerAdmissionRequest(validRequest)).toMatchObject({ ok: true });
  expect(validRequest).toMatchObject({
    operation: 'renderer.ownerAdmission',
    schema: 'renderer-owner-admission/v1',
    shadowSubmitMode: 'coalesced-with-frame',
    identity,
  });
});

test('renderer owner request rejects unknown mode and incomplete identity', () => {
  expect(validateRendererOwnerAdmissionRequest({
    ...validRequest,
    shadowSubmitMode: 'independent-and-coalesced',
  })).toMatchObject({
    ok: false,
    error: {
      code: 'renderer-owner-admission-invalid-mode',
      expected: { shadowSubmitMode: ['independent', 'coalesced-with-frame'] },
      recoveryActions: ['renderer.ownerAdmission.rediscover'],
    },
  });

  const { rendererGeneration: _rendererGeneration, ...incompleteIdentity } = identity;
  expect(validateRendererOwnerAdmissionRequest({ ...validRequest, identity: incompleteIdentity as never })).toMatchObject({
    ok: false,
    error: {
      code: 'renderer-owner-admission-identity-mismatch',
      expected: { identityFields: Object.keys(identity) },
      recoveryActions: ['renderer.ownerAdmission.rediscover'],
    },
  });
});

test('only a complete public A/B result with exact apply and restore counts is admitted', () => {
  expect(validateRendererOwnerAdmissionResult(admittedResult)).toMatchObject({ ok: true });

  for (const invalid of [
    { ...admittedResult, appliedCount: 0 },
    { ...admittedResult, restoredCount: 2 },
    { ...admittedResult, baseline: null },
    { ...admittedResult, ab: null },
    { ...admittedResult, drawCaptureParity: false },
    { ...admittedResult, evidenceSource: 'private-adapter' },
    { ...admittedResult, publicUrl: 'http://localhost:15173' },
    { ...admittedResult, ab: observation('independent') },
  ]) {
    expect(validateRendererOwnerAdmissionResult(invalid)).toMatchObject({
      ok: false,
      error: {
        code: 'renderer-owner-admission-incomplete',
        recoveryActions: ['renderer.ownerAdmission.rediscover'],
      },
    });
  }
});

test('blocked and inconclusive results remain structured and cannot masquerade as admission', () => {
  for (const status of ['blocked', 'inconclusive'] as const) {
    const result: RendererOwnerAdmissionResult = {
      status,
      operation: RENDERER_OWNER_ADMISSION_OPERATION,
      identity,
      appliedCount: 0,
      restoredCount: 0,
      baseline: null,
      ab: null,
      drawCaptureParity: null,
      evidenceSource: 'public-studio-carrier',
      publicUrl: 'http://localhost:18920',
      failure: {
        code: 'renderer-owner-admission-adapter-unavailable',
        category: 'availability',
        phase: 'discover',
        expected: { operation: RENDERER_OWNER_ADMISSION_OPERATION },
        hint: 'Stop the selected public run, rediscover the capability, and retry on one fresh carrier.',
        recoveryActions: ['renderer.ownerAdmission.rediscover'],
        safeRerun: true,
      },
    };

    expect(validateRendererOwnerAdmissionResult(result)).toMatchObject({ ok: true });
  }
});

test('renderer owner contract keeps transport input and output schemas independently typed', () => {
  expect(RENDERER_OWNER_ADMISSION_SCHEMA).toBe('renderer-owner-admission/v1');
  expect(RENDERER_OWNER_ADMISSION_OPERATION).toBe('renderer.ownerAdmission');
  expect(validateRendererOwnerAdmissionRequest({
    ...validRequest,
    identity: {
      ...identity,
      rendererGeneration: 'renderer-generation-2',
    },
  })).toMatchObject({ ok: true });

  const mismatchedGeneration = {
    ...admittedResult,
    ab: observation('coalesced-with-frame'),
    identity: { ...identity, rendererGeneration: 'renderer-generation-2' },
  };
  expect(validateRendererOwnerAdmissionResult(mismatchedGeneration)).toMatchObject({
    ok: false,
    error: {
      code: 'renderer-owner-admission-identity-mismatch',
      recoveryActions: ['renderer.ownerAdmission.rediscover'],
    },
  });
});
