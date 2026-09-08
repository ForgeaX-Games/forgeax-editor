/**
 * VAG carrier `execution` is a wire subset of engine ExecutionReport.
 * sendVagMessage validates that subset; extra report fields must not ride along.
 */
export type VagExecutionEnvelope = {
  readonly schemaVersion: 1;
  readonly requestedTier: 'auto' | 'main-serial' | 'engine-worker' | 'shared';
  readonly actualTier: 'main-serial' | 'engine-worker' | 'shared' | null;
  readonly selectionReason:
    | 'explicit-request'
    | 'auto-shared'
    | 'auto-engine-worker'
    | 'auto-main-serial'
    | null;
  readonly engine: {
    readonly realm: 'host' | 'worker';
    readonly health: 'idle' | 'starting' | 'running' | 'stopped' | 'faulted';
  };
  readonly fault: { readonly code: string; readonly hint: string } | null;
};

function isRequestedTier(value: unknown): value is VagExecutionEnvelope['requestedTier'] {
  return value === 'auto' || value === 'main-serial' || value === 'engine-worker' || value === 'shared';
}

function isActualTier(value: unknown): value is VagExecutionEnvelope['actualTier'] {
  return value === null || value === 'main-serial' || value === 'engine-worker' || value === 'shared';
}

function isSelectionReason(value: unknown): value is VagExecutionEnvelope['selectionReason'] {
  return value === null
    || value === 'explicit-request'
    || value === 'auto-shared'
    || value === 'auto-engine-worker'
    || value === 'auto-main-serial';
}

function isEngine(value: unknown): value is VagExecutionEnvelope['engine'] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const engine = value as { realm?: unknown; health?: unknown };
  return (engine.realm === 'host' || engine.realm === 'worker')
    && (engine.health === 'idle'
      || engine.health === 'starting'
      || engine.health === 'running'
      || engine.health === 'stopped'
      || engine.health === 'faulted');
}

/** Project a live ExecutionReport onto the VAG carrier execution envelope. */
export function toVagExecutionEnvelope(report: unknown): VagExecutionEnvelope | null {
  if (report === null || report === undefined || typeof report !== 'object' || Array.isArray(report)) {
    return null;
  }
  const candidate = report as {
    schemaVersion?: unknown;
    requestedTier?: unknown;
    actualTier?: unknown;
    selectionReason?: unknown;
    engine?: unknown;
    fault?: unknown;
  };
  if (candidate.schemaVersion !== 1
    || !isRequestedTier(candidate.requestedTier)
    || !isActualTier(candidate.actualTier)
    || !isSelectionReason(candidate.selectionReason)
    || !isEngine(candidate.engine)) {
    return null;
  }
  const fault = candidate.fault;
  let wireFault: VagExecutionEnvelope['fault'] = null;
  if (fault !== null && fault !== undefined) {
    if (typeof fault !== 'object' || Array.isArray(fault)) return null;
    const detail = fault as { code?: unknown; hint?: unknown };
    if (typeof detail.code !== 'string' || detail.code.length === 0
      || typeof detail.hint !== 'string' || detail.hint.length === 0) {
      return null;
    }
    wireFault = { code: detail.code, hint: detail.hint };
  }
  return {
    schemaVersion: 1,
    requestedTier: candidate.requestedTier,
    actualTier: candidate.actualTier,
    selectionReason: candidate.selectionReason,
    engine: { realm: candidate.engine.realm, health: candidate.engine.health },
    fault: wireFault,
  };
}
