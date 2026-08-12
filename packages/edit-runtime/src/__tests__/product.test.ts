import { describe, expect, test } from 'bun:test';

import * as product from '../public/product';
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
});
