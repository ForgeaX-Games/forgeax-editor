import { expect, test } from 'bun:test';

import {
  createReferenceCreationRuntime,
  type GatewayCreationPort,
} from '../../runtime/reference-creation';

function port(): GatewayCreationPort & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    listOps: () => [
      {
        id: 'addSceneAssetToScene',
        available: true,
        operationRun: true,
      },
      {
        id: 'createAsset',
        available: false,
        capabilityGeneration: 'g0',
        blocked: {
          code: 'capability-blocked',
          stage: 'preflight',
          owner: '@forgeax/editor-core OperationRun/applier contract owner',
          diagnosticId: 'q5-create-asset-terminal-run',
          recoveryAction: 'owner.repair',
        },
      },
    ],
    assetCatalog: () => [{ guid: 'scene-native-1', kind: 'scene', name: 'Native Seed' }],
    dispatch: (command) => {
      calls.push(command.kind);
      if (command.kind === 'addSceneAssetToScene') {
        return {
          ok: true,
          operationRun: {
            requestId: String(command.requestId),
            runId: 'operation-native-seed-1',
            status: 'running',
          },
        };
      }
      return {
        ok: false,
        error: {
          code: 'capability-blocked',
          stage: 'preflight',
          owner: '@forgeax/editor-core OperationRun/applier contract owner',
          diagnosticId: 'q5-create-asset-terminal-run',
          recoveryAction: 'owner.repair',
          capabilityGeneration: 'g0',
        },
      };
    },
    waitOperationRun: async (requestId) => ({
      ok: true,
      value: {
        requestId,
        runId: 'operation-native-seed-1',
        status: 'succeeded',
      },
    }),
  };
}

const completeInput = {
  creationRunId: 'creation-m2-1',
  referenceFingerprint: 'sha256:reference-m2',
  targetProject: 'games/reference',
  targetScene: 'default',
  originalStage: 'blockout',
  viewSemantics: 'front orthographic reference view',
  visibleFacts: ['root silhouette'],
  inferredFacts: ['hidden back face'],
  unknownFacts: ['occluded underside'],
  fidelityFocus: ['silhouette', 'child relationship', 'warm and cool material regions'],
  correctionBudget: { perStage: 3, total: 12 },
};

test('M2 records native terminal success then the same-run q5 blocked gap', async () => {
  const gateway = port();
  const runtime = createReferenceCreationRuntime({ gateway });
  const result = await runtime.start(completeInput);

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toMatchObject({
    code: 'capability-gap',
    capabilityId: 'scene.createAsset',
    capabilityGeneration: 'g0',
    stage: 'preflight',
    owner: '@forgeax/editor-core OperationRun/applier contract owner',
    diagnosticId: 'q5-create-asset-terminal-run',
    recoveryAction: 'owner.repair',
  });
  expect(result.run).toMatchObject({
    creationRunId: 'creation-m2-1',
    originalStage: 'blockout',
    priorOperationRunId: 'operation-native-seed-1',
    dispatchCount: 1,
    commitCount: 1,
    mutationCount: 1,
    saveCount: 0,
    captureCount: 0,
    stageAdvanceCount: 0,
    nextStep: 'owner.repair',
    q5Gap: {
      originalStage: 'blockout',
      capabilityGeneration: 'g0',
      owner: '@forgeax/editor-core OperationRun/applier contract owner',
      diagnosticId: 'q5-create-asset-terminal-run',
      nextStep: 'owner.repair',
    },
  });
  expect(gateway.calls).toEqual(['addSceneAssetToScene', 'createAsset']);
});

test('M2 stops before mutation when required input is incomplete', async () => {
  const gateway = port();
  const runtime = createReferenceCreationRuntime({ gateway });
  const result = await runtime.start({ ...completeInput, referenceFingerprint: '' });

  expect(result).toMatchObject({
    ok: false,
    error: { code: 'creation-input-incomplete', stage: 'preflight' },
    run: { mutationCount: 0, dispatchCount: 0, commitCount: 0 },
  });
  expect(gateway.calls).toEqual([]);
});

test('M2 recovery reads the original blocked run without replaying the seed', async () => {
  const gateway = port();
  const runtime = createReferenceCreationRuntime({ gateway });
  const first = await runtime.start(completeInput);
  expect(first.ok).toBe(false);

  const resumed = runtime.resume('creation-m2-1');
  expect(resumed).toMatchObject({
    ok: true,
    value: {
      creationRunId: 'creation-m2-1',
      originalStage: 'blockout',
      priorOperationRunId: 'operation-native-seed-1',
      dispatchCount: 1,
      commitCount: 1,
      nextStep: 'owner.repair',
    },
  });
  expect(gateway.calls).toEqual(['addSceneAssetToScene', 'createAsset']);
});
