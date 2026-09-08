import { expect, test } from 'bun:test';

import {
  createEditorProduct,
  REFERENCE_CREATION_REQUIRED_INPUTS,
  REFERENCE_CREATION_SHORTEST_ROUTE,
  type ReferenceCreationAction,
  type ReferenceCreationInput,
  type ReferenceCreationTransportRequest,
} from '@forgeax/editor-product';

const coldInput = {
  creationRunId: 'cold-contract-run',
  referenceFingerprint: 'sha256:cold-contract',
  targetProject: 'games/reference',
  targetScene: 'default',
  originalStage: 'blockout',
  viewSemantics: 'front orthographic reference view',
  visibleFacts: ['root silhouette'],
  inferredFacts: ['hidden back face'],
  unknownFacts: ['occluded underside'],
  fidelityFocus: ['silhouette', 'hierarchy'],
  correctionBudget: { perStage: 3, total: 12 },
} satisfies ReferenceCreationInput;

const coldRequests = [
  { action: 'discover' },
  { action: 'preflight', input: coldInput },
  { action: 'start', input: coldInput },
  { action: 'resume', creationRunId: coldInput.creationRunId },
  { action: 'ownerRepairAndResume', creationRunId: coldInput.creationRunId },
  {
    action: 'createNativeEntities',
    creationRunId: coldInput.creationRunId,
    specs: [{ mutationId: 'root', name: 'Reference Root', components: {} }],
  },
  {
    action: 'correct',
    creationRunId: coldInput.creationRunId,
    correction: {
      stage: coldInput.originalStage,
      issueGroup: { id: 'silhouette', issues: ['root silhouette needs correction'] },
      command: { kind: 'spawnEntity', requestId: 'cold-correction' },
    },
  },
  {
    action: 'recordEvidence',
    creationRunId: coldInput.creationRunId,
    event: { kind: 'stage-advanced', stage: coldInput.originalStage, evidenceId: 'native-committed' },
  },
  {
    action: 'appendVisualReview',
    creationRunId: coldInput.creationRunId,
    facts: {
      authoredBy: 'verify',
      executor: 'step-verify-visual-executor',
      expectation: 'edit-prop-after-reopen',
      observed: { targetCount: 1 },
      verdict: 'unproven',
      confidence: 0,
      capture: { runId: 'capture-pending', tapePath: 'pending.tape.bin', reportPath: 'pending.report.json' },
      renderer: { backend: 'webgpu', generation: 1, carrierGeneration: 1, rendererIdentity: 'pending' },
    },
  },
  {
    action: 'finalize',
    creationRunId: coldInput.creationRunId,
    dimensions: { input: 'pass', structure: 'unproven', persistence: 'unproven', play: 'unproven', visual: 'unproven', toolCompleteness: 'unproven' },
  },
  { action: 'journal', creationRunId: coldInput.creationRunId },
] satisfies readonly ReferenceCreationTransportRequest[];

const coldActions = coldRequests.map(({ action }) => action) as readonly ReferenceCreationAction[];

test('product entry exposes a UI-free blocking contract', () => {
  const product = createEditorProduct();
  const discovered = product.discover();

  expect(discovered.manifest.productId).toBe('@forgeax/editor-product');
  expect(discovered.manifest.uiFree).toBe(true);
  expect(discovered.availability).toMatchObject({
    available: false,
    blocking: true,
    code: 'wave1-input-blocked',
  });
});

test('package root exposes the complete cold reference-creation request contract', () => {
  expect(REFERENCE_CREATION_REQUIRED_INPUTS).toContain('creationRunId');
  expect(REFERENCE_CREATION_REQUIRED_INPUTS).toContain('originalStage');
  expect(coldActions).toEqual(REFERENCE_CREATION_SHORTEST_ROUTE);
  expect(new Set(coldActions).size).toBe(REFERENCE_CREATION_SHORTEST_ROUTE.length);
  expect(coldRequests).toHaveLength(REFERENCE_CREATION_SHORTEST_ROUTE.length);
  expect(coldRequests.find((request) => request.action === 'appendVisualReview')).toMatchObject({
    facts: { authoredBy: 'verify', verdict: 'unproven', confidence: 0 },
  });
});
