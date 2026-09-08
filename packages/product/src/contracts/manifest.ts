// Versioned capability manifest derived from CapabilityRegistry.

import type { CapabilityDescriptor } from './capability';

export const PRODUCT_CONTRACT_MANIFEST_VERSION = 'editor-product/v1' as const;
export const PRODUCT_CONTRACT_VERSION = '0.1.0' as const;

export const REFERENCE_CREATION_REQUIRED_INPUTS = Object.freeze([
  'creationRunId',
  'referenceFingerprint',
  'targetProject',
  'targetScene',
  'originalStage',
  'viewSemantics',
  'visibleFacts',
  'inferredFacts',
  'unknownFacts',
  'fidelityFocus',
  'correctionBudget',
] as const);

export const REFERENCE_CREATION_SHORTEST_ROUTE = Object.freeze([
  'discover',
  'preflight',
  'start',
  'resume',
  'ownerRepairAndResume',
  'createNativeEntities',
  'correct',
  'recordEvidence',
  'appendVisualReview',
  'finalize',
  'journal',
] as const);

export interface ReferenceCreationLifecycleRoute {
  readonly save: { readonly action: 'recordEvidence'; readonly eventKind: 'save-committed'; readonly stage: 'save' };
  readonly reopen: { readonly action: 'recordEvidence'; readonly eventKind: 'stage-advanced'; readonly stage: 'edit-after-reopen' };
  readonly play: { readonly action: 'recordEvidence'; readonly eventKind: 'stage-advanced'; readonly stage: 'play-roundtrip' };
  readonly capture: { readonly action: 'recordEvidence'; readonly eventKind: 'capture-committed'; readonly stages: readonly ['edit-after-reopen', 'play-roundtrip'] };
}

export const REFERENCE_CREATION_LIFECYCLE: ReferenceCreationLifecycleRoute = Object.freeze({
  save: { action: 'recordEvidence' as const, eventKind: 'save-committed' as const, stage: 'save' as const },
  reopen: { action: 'recordEvidence' as const, eventKind: 'stage-advanced' as const, stage: 'edit-after-reopen' as const },
  play: { action: 'recordEvidence' as const, eventKind: 'stage-advanced' as const, stage: 'play-roundtrip' as const },
  capture: { action: 'recordEvidence' as const, eventKind: 'capture-committed' as const, stages: ['edit-after-reopen', 'play-roundtrip'] as const },
});

export interface ProductContractManifest {
  readonly manifestVersion: typeof PRODUCT_CONTRACT_MANIFEST_VERSION;
  readonly contractVersion: typeof PRODUCT_CONTRACT_VERSION;
  readonly productId: '@forgeax/editor-product';
  readonly uiFree: true;
  readonly capabilitySource: 'registered-ssot';
  readonly skills: readonly ProductSkillManifest[];
}

export interface ProductSkillManifest {
  readonly id: 'forgeax-reference-creation';
  readonly name: string;
  readonly purpose: string;
  readonly requiredInputs: typeof REFERENCE_CREATION_REQUIRED_INPUTS;
  readonly boundaries: readonly string[];
  readonly publicEntry: 'createReferenceCreationEntry';
  readonly publicRoute: 'reference-creation';
  readonly shortestRoute: typeof REFERENCE_CREATION_SHORTEST_ROUTE;
  readonly lifecycle: ReferenceCreationLifecycleRoute;
  readonly zeroWritePreflight: {
    readonly mutates: false;
    readonly checks: readonly string[];
  };
}

export const REFERENCE_CREATION_SKILL_MANIFEST: ProductSkillManifest = Object.freeze({
  id: 'forgeax-reference-creation',
  name: 'ForgeaX Reference Creation',
  purpose: 'Create a bounded native static prop from a reference while preserving Gateway, journal, round-trip, Play, and visual evidence boundaries.',
  requiredInputs: REFERENCE_CREATION_REQUIRED_INPUTS,
  boundaries: Object.freeze([
    'Gateway operations only',
    'native scene and asset facts only',
    'no placeholder or private scene format',
    'fresh Play world and Worker-owned diagnostics',
  ]),
  publicEntry: 'createReferenceCreationEntry',
  publicRoute: 'reference-creation',
  shortestRoute: REFERENCE_CREATION_SHORTEST_ROUTE,
  lifecycle: REFERENCE_CREATION_LIFECYCLE,
  zeroWritePreflight: Object.freeze({
    mutates: false,
    checks: Object.freeze([
      'input completeness and target boundary',
      'required live operations and terminal contracts',
      'capability generation and recovery owner',
    ]),
  }),
});

export const PRODUCT_CONTRACT_MANIFEST: ProductContractManifest = Object.freeze({
  manifestVersion: PRODUCT_CONTRACT_MANIFEST_VERSION,
  contractVersion: PRODUCT_CONTRACT_VERSION,
  productId: '@forgeax/editor-product',
  uiFree: true,
  capabilitySource: 'registered-ssot',
  skills: Object.freeze([REFERENCE_CREATION_SKILL_MANIFEST]),
});

export const PRODUCT_CAPABILITY_MANIFEST_VERSION = 'editor-product/capabilities-v1' as const;

export interface CapabilityManifest {
  readonly manifestVersion: typeof PRODUCT_CAPABILITY_MANIFEST_VERSION;
  readonly contractVersion: string;
  readonly productId: '@forgeax/editor-product';
  readonly generatedFrom: 'capability-registry';
  readonly capabilities: readonly CapabilityDescriptor[];
  readonly progressiveDisclosure: CapabilityProgressiveDisclosure;
}

export interface CapabilityProgressiveDisclosure {
  readonly proposition: string;
  readonly requiredInputs: readonly string[];
  readonly shortestPath: readonly string[];
  readonly stages: readonly string[];
  readonly evidence: readonly string[];
  readonly recovery: readonly string[];
}

export function createCapabilityManifest(
  capabilities: readonly CapabilityDescriptor[],
  contractVersion: string,
): CapabilityManifest {
  const recovery = [...new Set(capabilities.flatMap((capability) => capability.recoveryActions))];
  return Object.freeze({
    manifestVersion: PRODUCT_CAPABILITY_MANIFEST_VERSION,
    contractVersion,
    productId: '@forgeax/editor-product' as const,
    generatedFrom: 'capability-registry' as const,
    capabilities: Object.freeze([...capabilities]),
    progressiveDisclosure: Object.freeze({
      proposition: 'Discover a capability, preflight its owner contract, then dispatch only when callable.',
      requiredInputs: Object.freeze(['descriptor', 'schema', 'availability']),
      shortestPath: Object.freeze(['discover', 'preflight']),
      stages: Object.freeze(['discover', 'preflight', 'dispatch', 'wait', 'query', 'save', 'reopen', 'play', 'capture', 'resume']),
      evidence: Object.freeze(['descriptor', 'schema', 'operationRun', 'completion']),
      recovery: Object.freeze(recovery),
    }),
  });
}
