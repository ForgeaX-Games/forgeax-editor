import {
  EXECUTION_CAPABILITY_NAMES,
  type ExecutionControl,
  type ExecutionReport,
} from '@forgeax/engine-app';
import type { RuntimeDiagnosticFact, RuntimeDiagnosticsProvider } from '@forgeax/editor-core';

export interface EngineExecutionDiagnosticsBridge {
  readonly provider: RuntimeDiagnosticsProvider;
  readonly report: () => ExecutionReport;
}

function unavailableCapabilities(report: ExecutionReport): readonly string[] {
  return EXECUTION_CAPABILITY_NAMES.filter((name) => !report.capabilities[name].available);
}

function executionDiagnostic(report: ExecutionReport): RuntimeDiagnosticFact {
  const actualTier = report.actualTier ?? 'pending';
  const faulted = report.fault !== null || report.world.health === 'poisoned' || report.engine.health === 'faulted';
  return Object.freeze({
    id: 'execution-report',
    severity: faulted ? 'error' : 'info',
    code: report.fault?.code ?? `engine-execution-${actualTier}`,
    title: `Engine execution: ${actualTier}`,
    message: `Requested ${report.requestedTier}; actual ${actualTier}; engine ${report.engine.health}; world ${report.world.health}.`,
    retryable: report.fault?.retryable ?? false,
    recoveryActions: Object.freeze([]),
    detail: Object.freeze({
      report,
      unavailableCapabilities: Object.freeze(unavailableCapabilities(report)),
      provenance: Object.freeze({ source: '@forgeax/engine-app', schemaVersion: report.schemaVersion }),
    }),
  });
}

/** Project the producer-owned App report without retaining an Editor copy. */
export function createEngineExecutionDiagnostics(
  execution: ExecutionControl,
): EngineExecutionDiagnosticsBridge {
  const report = (): ExecutionReport => execution.report();
  return {
    report,
    provider: {
      id: 'engine-execution',
      snapshot: () => [executionDiagnostic(report())],
    },
  };
}
