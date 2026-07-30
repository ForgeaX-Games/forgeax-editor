import { registerBuiltinOp } from './catalog';
import { LiveWorldSelectorGraph, type MountedSelector, type SelectorSubscription } from '../store/live-world-selector-graph';
export interface RuntimeUiStats {
  readonly status: 'bound' | 'unbound' | 'disposed';
  readonly worldGeneration: number;
  readonly cacheEntries: number;
  readonly listeners: number;
  readonly snapshotBytes: number;
  readonly frameOpportunity: number;
  readonly domainPublishCount: number;
  readonly stalePublishes: number;
}

export type RuntimeUiDomain = 'authored' | 'asset' | 'history' | 'scene' | 'schema';

export interface RuntimeUiDomainCounters {
  readonly runtimeFrameCount: number;
  readonly authoredPublishCount: number;
  readonly assetPublishCount: number;
  readonly historyPublishCount: number;
  readonly scenePublishCount: number;
  readonly schemaPublishCount: number;
}

let domainCounters: RuntimeUiDomainCounters = {
  runtimeFrameCount: 0,
  authoredPublishCount: 0,
  assetPublishCount: 0,
  historyPublishCount: 0,
  scenePublishCount: 0,
  schemaPublishCount: 0,
};

const domainCounterKey: Record<RuntimeUiDomain, keyof RuntimeUiDomainCounters> = {
  authored: 'authoredPublishCount',
  asset: 'assetPublishCount',
  history: 'historyPublishCount',
  scene: 'scenePublishCount',
  schema: 'schemaPublishCount',
};

/** Record producer activity without retaining the producer's business data. */
export function recordRuntimeUiDomainPublish(domain: RuntimeUiDomain): void {
  const key = domainCounterKey[domain];
  domainCounters = { ...domainCounters, [key]: domainCounters[key] + 1 };
}

function readRuntimeUiDomainCounters(): RuntimeUiDomainCounters {
  return domainCounters;
}

export interface RuntimeUiProvenance {
  readonly worldGeneration: number;
  readonly source: string;
  readonly evidenceId: string;
}

export interface RuntimeUiError {
  readonly code: string;
  readonly hint: string;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly retryable: boolean;
}

export interface RuntimeUiCapabilities {
  readonly schemaVersion: 1;
  readonly status: 'success' | 'unbound' | 'stale' | 'unsupported' | 'read-failed';
  readonly provenance: RuntimeUiProvenance;
  readonly counters: Pick<RuntimeUiStats, 'cacheEntries' | 'listeners' | 'snapshotBytes' | 'frameOpportunity' | 'domainPublishCount' | 'stalePublishes'> & RuntimeUiDomainCounters;
}

export interface RuntimeUiDiagnostics extends RuntimeUiCapabilities {
  readonly status: 'success' | 'unbound' | 'stale' | 'unsupported' | 'read-failed';
  readonly code?: string;
  readonly hint?: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly retryable?: boolean;
}

export type RuntimeUiParseResult =
  | { readonly ok: true; readonly value: RuntimeUiDiagnostics }
  | { readonly ok: false; readonly error: RuntimeUiError };

export const RUNTIME_UI_OPERATION_MANIFEST = Object.freeze([
  { id: 'runtime-ui.capabilities', domain: 'transient' as const, title: 'Read runtime UI capabilities' },
  { id: 'runtime-ui.diagnostics', domain: 'transient' as const, title: 'Read runtime UI diagnostics' },
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorResult(code: string, hint: string, actual: unknown): RuntimeUiParseResult {
  return { ok: false, error: { code, hint, expected: 'schema-valid runtime UI diagnostics', actual, retryable: false } };
}

export function parseRuntimeUiDiagnostics(value: unknown): RuntimeUiParseResult {
  if (!isRecord(value) || value.schemaVersion !== 1) return errorResult('diagnostics-schema-invalid', 'Use schemaVersion 1 and the documented diagnostics shape.', value);
  const status = value.status;
  if (!['success', 'unbound', 'stale', 'unsupported', 'read-failed'].includes(String(status))) {
    return errorResult('diagnostics-status-invalid', 'Use a documented runtime UI diagnostics status.', status);
  }
  const provenance = value.provenance;
  if (!isRecord(provenance) || !Number.isInteger(provenance.worldGeneration) || typeof provenance.source !== 'string' || typeof provenance.evidenceId !== 'string') {
    return errorResult('diagnostics-provenance-invalid', 'Read provenance.worldGeneration, provenance.source, and provenance.evidenceId from the current response.', provenance);
  }
  const needsError = status === 'unsupported' || status === 'read-failed';
  if (needsError && (typeof value.code !== 'string' || typeof value.hint !== 'string' || typeof value.retryable !== 'boolean' || !('expected' in value) || !('actual' in value))) {
    return errorResult('diagnostics-error-incomplete', 'Use code, hint, expected, actual, and retryable to recover the diagnostics request.', value);
  }
  if ('businessValue' in value || 'payload' in value || 'selectorValue' in value) {
    return errorResult('diagnostics-business-payload', 'Diagnostics expose counters and recovery metadata, not selector business values.', value);
  }
  return { ok: true, value: value as unknown as RuntimeUiDiagnostics };
}

function provenanceOf(stats: RuntimeUiStats, source: string): RuntimeUiProvenance {
  return { worldGeneration: stats.worldGeneration, source, evidenceId: `runtime-ui-${stats.worldGeneration}-${stats.domainPublishCount}` };
}

function countersOf(stats: RuntimeUiStats, baseline: RuntimeUiDomainCounters): RuntimeUiCapabilities['counters'] {
  const domains = readRuntimeUiDomainCounters();
  return {
    cacheEntries: stats.cacheEntries,
    listeners: stats.listeners,
    snapshotBytes: stats.snapshotBytes,
    frameOpportunity: stats.frameOpportunity,
    domainPublishCount: stats.domainPublishCount,
    stalePublishes: stats.stalePublishes,
    runtimeFrameCount: stats.frameOpportunity,
    authoredPublishCount: domains.authoredPublishCount - baseline.authoredPublishCount,
    assetPublishCount: domains.assetPublishCount - baseline.assetPublishCount,
    historyPublishCount: domains.historyPublishCount - baseline.historyPublishCount,
    scenePublishCount: domains.scenePublishCount - baseline.scenePublishCount,
    schemaPublishCount: domains.schemaPublishCount - baseline.schemaPublishCount,
  };
}

export interface RuntimeUiOperations {
  readonly capabilities: () => RuntimeUiCapabilities;
  readonly diagnostics: () => RuntimeUiDiagnostics;
}

export interface RuntimeUiGraph {
  readonly bindWorld: (world: unknown) => number;
  readonly unbindWorld: (expectedWorld?: unknown) => boolean;
  readonly publish: (options?: { readonly world?: unknown; readonly worldGeneration?: number }) => string;
  readonly stats: () => RuntimeUiStats;
  readonly mount: <T>(selector: MountedSelector<T>) => SelectorSubscription<T>;
}

let activeRuntimeUiGraph: RuntimeUiGraph | null = null;

export function createRuntimeUiGraph(): RuntimeUiGraph {
  const graph = new LiveWorldSelectorGraph();
  activeRuntimeUiGraph = graph;
  return graph;
}

/** Return the graph owned by the active Editor host session. */
export function getActiveRuntimeUiGraph(): RuntimeUiGraph | null {
  return activeRuntimeUiGraph;
}

export function createRuntimeUiOperations(graph: { stats(): RuntimeUiStats }, source = 'editor-core'): RuntimeUiOperations {
  registerBuiltinOp({ id: 'runtime-ui.capabilities', domain: 'transient', argsSchema: null, title: 'Read runtime UI capabilities' });
  registerBuiltinOp({ id: 'runtime-ui.diagnostics', domain: 'transient', argsSchema: null, title: 'Read runtime UI diagnostics' });
  const baseline = readRuntimeUiDomainCounters();
  const read = (): RuntimeUiDiagnostics => {
    const stats = graph.stats();
    const provenance = provenanceOf(stats, source);
    const counters = countersOf(stats, baseline);
    if (stats.status === 'disposed') return { schemaVersion: 1, status: 'read-failed', provenance, counters, code: 'diagnostics-disposed', hint: 'Create a new Editor session before reading runtime UI diagnostics.', expected: 'bound graph', actual: 'disposed graph', retryable: false };
    if (stats.status === 'unbound') return { schemaVersion: 1, status: 'unbound', provenance, counters };
    return { schemaVersion: 1, status: 'success', provenance, counters };
  };
  return {
    capabilities: () => {
      const diagnostics = read();
      return diagnostics;
    },
    diagnostics: read,
  };
}
