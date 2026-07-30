import {
  createAssetSubject,
  createAssetWorkspaceSnapshot,
  type AssetMutationOperation,
  type AssetMutationRequest,
} from '../contracts/asset-workspace';
import {
  createAssetLifecycleAdapter,
  preflightAssetMutation,
} from './preflight';
import { reconcileImportedTopology } from './subject-capability';
import {
  createAssetConformanceReport,
  type AssetConformanceFailure,
  type AssetConformanceReport,
} from './conformance-report';

export interface AssetConformanceScenario {
  readonly id: string;
  readonly title: string;
  readonly kind: 'lifecycle' | 'safety';
  readonly acAnchor: `AC-${string}`;
  readonly fixtureAnchor: `fixture:${string}`;
  readonly recoveryActions: readonly string[];
}

function lifecycleScenario(index: number): AssetConformanceScenario {
  return {
    id: `A${String(index + 1).padStart(2, '0')}`,
    title: `public asset lifecycle scenario ${index + 1}`,
    kind: 'lifecycle',
    acAnchor: 'AC-15',
    fixtureAnchor: 'fixture:asset-lifecycle',
    recoveryActions: ['asset.preflight', 'asset.restore'],
  };
}

function safetyScenario(index: number): AssetConformanceScenario {
  const number = index + 1;
  const acAnchor = number === 7 ? 'AC-17' : number === 8 ? 'AC-10' : 'AC-16';
  const recoveryActions = number === 7 ? ['asset.reconcile'] : ['asset.preflight', 'asset.restore'];
  return {
    id: `H${String(number).padStart(2, '0')}`,
    title: `asset safety boundary scenario ${number}`,
    kind: 'safety',
    acAnchor,
    fixtureAnchor: `fixture:asset-safety-h${String(number).padStart(2, '0')}`,
    recoveryActions,
  };
}

const lifecycleOperations: readonly AssetMutationOperation[] = [
  'rename',
  'move',
  'delete',
  'replace',
  'duplicate',
  'reimport',
];

export const ASSET_CONFORMANCE_SCENARIOS: readonly AssetConformanceScenario[] = Object.freeze([
  ...Array.from({ length: 63 }, (_, index) => lifecycleScenario(index)),
  ...Array.from({ length: 8 }, (_, index) => safetyScenario(index)),
]);

function createConformanceSnapshot() {
  return createAssetWorkspaceSnapshot({
    revision: 'workspace:conformance',
    resourceRevision: 'resource:conformance',
    subjects: [
      createAssetSubject({
        id: 'subject:conformance',
        kind: 'internal-asset',
        provenance: { owner: 'engine', source: 'public-adapter', packageId: 'package:conformance' },
        resourceId: 'resource:conformance',
        path: 'assets/conformance.pack.json',
        capabilities: { canImport: false, canMove: true, canDelete: true, canPreflight: true },
      }),
      createAssetSubject({
        id: 'subject:imported-output',
        kind: 'imported-output',
        provenance: { owner: 'engine', source: 'public-adapter', packageId: 'package:conformance' },
        resourceId: 'resource:imported-output',
        path: 'assets/conformance-imported.pack.json',
        capabilities: { canImport: false, canMove: false, canDelete: false, canPreflight: true },
      }),
    ],
    relations: [],
    issues: [],
  });
}

function expectedToken(snapshot: ReturnType<typeof createConformanceSnapshot>, request: AssetMutationRequest): string | undefined {
  return preflightAssetMutation(snapshot, request).confirmation.token;
}

function failureFor(id: string, error: unknown): AssetConformanceFailure {
  return {
    scenarioId: id,
    code: error instanceof Error ? 'scenario-threw' : 'scenario-failed',
    hint: error instanceof Error ? error.message : 'The public scenario assertion failed.',
  };
}

async function runLifecycleScenario(scenario: AssetConformanceScenario): Promise<void> {
  const snapshot = createConformanceSnapshot();
  const operation = lifecycleOperations[Number(scenario.id.slice(1)) % lifecycleOperations.length] ?? 'rename';
  const request = { operation, subjectId: 'subject:conformance' } as const;
  const adapter = createAssetLifecycleAdapter({
    getSnapshot: () => snapshot,
    commit: async () => ({ revision: 'resource:conformance:next', snapshot }),
  });
  const token = expectedToken(snapshot, request);
  const result = await adapter.run({ ...request, confirmationToken: token });
  if (!result.ok || result.mutationCount !== 1) throw new Error(`${scenario.id} did not commit through the public adapter`);
}

async function runSafetyScenario(scenario: AssetConformanceScenario): Promise<void> {
  const snapshot = createConformanceSnapshot();
  if (scenario.id === 'H01') {
    const adapter = createAssetLifecycleAdapter({ getSnapshot: () => snapshot, commit: async () => ({ revision: 'bad' }) });
    const result = await adapter.run({ operation: 'delete', subjectId: 'subject:conformance' });
    if (result.ok || result.mutationCount !== 0) throw new Error('missing confirmation was accepted');
    return;
  }
  if (scenario.id === 'H02') {
    const adapter = createAssetLifecycleAdapter({ getSnapshot: () => snapshot, commit: async () => ({ revision: 'bad' }) });
    const result = await adapter.run({ operation: 'delete', subjectId: 'subject:conformance', confirmationToken: 'asset-confirmation:wrong' });
    if (result.ok || result.mutationCount !== 0) throw new Error('mismatched confirmation was accepted');
    return;
  }
  if (scenario.id === 'H03') {
    const adapter = createAssetLifecycleAdapter({ getSnapshot: () => snapshot, commit: async () => ({ revision: 'bad' }) });
    const result = await adapter.run({ operation: 'delete', subjectId: 'subject:conformance', expectedRevision: 'resource:old' });
    if (result.ok || result.error.code !== 'revision-conflict') throw new Error('stale revision was accepted');
    return;
  }
  if (scenario.id === 'H04') {
    const adapter = createAssetLifecycleAdapter({ getSnapshot: () => snapshot, commit: async () => ({ revision: 'bad' }) });
    const request = { operation: 'delete', subjectId: 'subject:imported-output' } as const;
    const result = await adapter.run({ ...request, confirmationToken: expectedToken(snapshot, request) });
    if (result.ok || result.mutationCount !== 0) throw new Error('imported output delete was accepted');
    return;
  }
  if (scenario.id === 'H05') {
    const request = { operation: 'move', subjectId: 'subject:conformance', scope: 'root:other' } as const;
    const result = preflightAssetMutation(snapshot, request, { scope: 'root:one' });
    if (result.ok || result.error?.code !== 'scope-conflict') throw new Error('scope conflict was accepted');
    return;
  }
  if (scenario.id === 'H06') {
    const request = { operation: 'move', subjectId: 'subject:conformance', owner: 'actor:incoming' } as const;
    const result = preflightAssetMutation(snapshot, request, { currentOwner: 'actor:existing' });
    if (result.ok || result.error?.code !== 'owner-conflict') throw new Error('owner conflict was accepted');
    return;
  }
  if (scenario.id === 'H07') {
    const result = reconcileImportedTopology({
      previous: [{ subjectId: 'subject:old', kind: 'mesh', sourceIndex: 0 }],
      next: [
        { subjectId: 'subject:left', kind: 'mesh', sourceIndex: 0 },
        { subjectId: 'subject:right', kind: 'mesh', sourceIndex: 0 },
      ],
      references: [{ referenceId: 'reference:old', subjectId: 'subject:old' }],
    });
    if (result.status !== 'ambiguous' || result.preservedReferences[0]?.subjectId !== 'subject:old') throw new Error('ambiguous topology was rebound');
    return;
  }
  const adapter = createAssetLifecycleAdapter({
    getSnapshot: () => snapshot,
    commit: async () => { throw new Error('injected resource failure'); },
  });
  const request = { operation: 'replace', subjectId: 'subject:conformance' } as const;
  const result = await adapter.run({ ...request, confirmationToken: expectedToken(snapshot, request) });
  if (result.ok || result.mutationCount !== 0 || result.error.code !== 'resource-transaction-failed') throw new Error('resource failure was not recoverable');
}

async function runScenario(scenario: AssetConformanceScenario): Promise<void> {
  if (scenario.kind === 'lifecycle') return runLifecycleScenario(scenario);
  return runSafetyScenario(scenario);
}

export async function runAssetConformance(): Promise<AssetConformanceReport> {
  const failures: AssetConformanceFailure[] = [];
  for (const scenario of ASSET_CONFORMANCE_SCENARIOS) {
    try {
      await runScenario(scenario);
    } catch (error) {
      failures.push(failureFor(scenario.id, error));
    }
  }
  return createAssetConformanceReport(
    ASSET_CONFORMANCE_SCENARIOS.map((scenario) => scenario.id),
    failures,
  );
}
