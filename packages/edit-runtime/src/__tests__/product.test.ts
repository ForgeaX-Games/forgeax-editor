import { describe, expect, test } from 'bun:test';
import { createEditorCarrierFacade } from '@forgeax/editor-core';

import * as product from '../public/product';
import { EDITOR_PAGE_CARRIER_DESCRIPTOR } from '../page-extension';
import type {
  AssetWorkspace,
  AssetWorkspaceDelta,
  AssetWorkspaceInput,
  AssetWorkspaceObservation,
  AssetWorkspaceRecoveryIntent,
  AssetWorkspaceReconcileResult,
  AssetWorkspaceResult,
  CapabilityDiscoveryOptions,
  HostParityReport,
  OperationDefinition,
  OperationRun,
  OperationRunEvent,
  OperationRunEventInput,
  OperationRunRequest,
  OperationRunStatus,
  RunAcceptedResult,
  RunActor,
  RunCoordinatorEvent,
  RunCoordinatorOptions,
  RunEventInput,
  RunJournalAcceptResult,
  RunJournalEventInput,
  RunJournalOptions,
  RunJournalRecord,
  RunJournalResult,
  RunProgress,
  TerminalRunStatus,
  TransportServiceOptions,
} from '../public/product';

type PublicProductTypes = {
  workspace: AssetWorkspace;
  workspaceDelta: AssetWorkspaceDelta;
  workspaceInput: AssetWorkspaceInput;
  workspaceObservation: AssetWorkspaceObservation;
  workspaceRecoveryIntent: AssetWorkspaceRecoveryIntent;
  workspaceReconcileResult: AssetWorkspaceReconcileResult;
  workspaceResult: AssetWorkspaceResult;
  capabilityDiscovery: CapabilityDiscoveryOptions;
  hostParity: HostParityReport;
  operationDefinition: OperationDefinition;
  operationRun: OperationRun;
  operationEvent: OperationRunEvent;
  operationEventInput: OperationRunEventInput;
  operationRequest: OperationRunRequest;
  operationStatus: OperationRunStatus;
  runAccepted: RunAcceptedResult;
  runActor: RunActor;
  coordinatorEvent: RunCoordinatorEvent;
  coordinatorOptions: RunCoordinatorOptions;
  runEventInput: RunEventInput;
  journalAccept: RunJournalAcceptResult;
  journalEventInput: RunJournalEventInput;
  journalOptions: RunJournalOptions;
  journalRecord: RunJournalRecord;
  journalResult: RunJournalResult<unknown>;
  runProgress: RunProgress;
  terminalStatus: TerminalRunStatus;
  transportOptions: TransportServiceOptions;
};

void (null as unknown as PublicProductTypes);

describe('@forgeax/editor/product public surface', () => {
  test('exposes the Gateway-backed product adapter through the facade', () => {
    expect(typeof (product as Record<string, unknown>).createGatewayCapabilityAdapter).toBe('function');
    expect((product as Record<string, unknown>).createEditorProductFromGateway).toBeUndefined();
  });

  test('exposes host-composition runtime constructors through the public subpath', () => {
    const workspace = product.createAssetWorkspace();
    const journal = new product.RunJournal({ scope: 'facade-test' });
    const coordinator = new product.OperationRunCoordinator();
    const registry = new product.CapabilityRegistry();
    const service = product.createTransportService({
      assetWorkspace: workspace,
      journal,
      product: product.createEditorProduct({ capabilityRegistry: registry }),
    });

    expect(typeof workspace.reconcile).toBe('function');
    expect(coordinator).toBeInstanceOf(product.OperationRunCoordinator);
    expect(journal).toBeInstanceOf(product.RunJournal);
    expect(registry).toBeInstanceOf(product.CapabilityRegistry);
    expect(typeof service.handle).toBe('function');
  });

  test('exposes the browser runtime port through the facade', () => {
    expect(typeof product.createBrowserGameRuntimePort).toBe('function');
  });

  test('exposes one identity, schema, capability, and recovery carrier envelope', async () => {
    const identity = {
      runtimeId: 'runtime-1',
      scope: { projectId: 'project-1', gameId: 'gta-route-dev' },
      pageIdentity: 'page-1',
      canvasIdentity: 'canvas-1',
      rendererGeneration: 3,
    } as const;
    let received: unknown;
    const facade = createEditorCarrierFacade({
      source: { listOps: () => [] },
      page: EDITOR_PAGE_CARRIER_DESCRIPTOR,
      getIdentity: () => identity,
      gameplay: {
        version: 1,
        execute: async (input) => {
          received = input;
          return {
            version: 1,
            operation: 'describe',
            ok: true,
            data: { operations: [] },
          };
        },
      },
    });

    const discovery = facade.discover();
    expect(discovery.version).toBe('editor-carrier/v1');
    expect(discovery.identity).toEqual(identity);
    expect(discovery.capabilities).toEqual([]);
    expect(discovery.schemas).toMatchObject({
      identity: 'GameplayIdentity/v1',
      gameplayRequest: 'GameplayOperationRequest/v1',
      gameplayResult: 'GameplayOperationResult/v1',
    });
    expect(discovery.page).toEqual(EDITOR_PAGE_CARRIER_DESCRIPTOR);
    expect(discovery.recoveryActions).toContain('editor.discover');

    const result = await facade.executeGameplay({ version: 1, operation: 'describe' });
    expect(result).toMatchObject({ version: 1, operation: 'describe', ok: true });
    expect(received).toEqual({ version: 1, operation: 'describe' });
    facade.dispose();
  });

  test('fails closed when the visible gameplay bridge is not mounted', async () => {
    const facade = createEditorCarrierFacade({
      source: { listOps: () => [] },
      page: EDITOR_PAGE_CARRIER_DESCRIPTOR,
      getIdentity: () => null,
    });

    await expect(facade.executeGameplay({ version: 1, operation: 'describe' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'surface-unavailable', retryable: true },
    });
    facade.dispose();
  });
});
