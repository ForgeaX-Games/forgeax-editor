import { describe, expect, test } from 'bun:test';

import * as product from '@forgeax/editor/product';
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
} from '@forgeax/editor/product';

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
});
