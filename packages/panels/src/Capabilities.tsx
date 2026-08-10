import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  DIAGNOSTICS_SCHEMA_VERSION,
  dispatchActiveEditorOperation,
  getViewportRuntimeClientSnapshot,
  listComponentSchemas,
  queryViewportRuntimeProjection,
  retryViewportRuntimeOperationRun,
  subscribeViewportRuntimeClient,
  type AssetBrowserRegistryEntry,
  type DiagnosticsSnapshot,
} from '@forgeax/editor-core';
import {
  EXECUTION_CAPABILITY_NAMES,
  isExecutionReport,
  type ExecutionReport,
} from '@forgeax/engine-app';
import {
  buildDiagnosticsRows,
  filterDiagnosticsRows,
  formatDiagnosticsDetail,
  getDiagnosticsProjectionSource,
  getDiagnosticsSnapshot,
  subscribeDiagnosticsProjection,
  type DiagnosticsPanelAction,
  type DiagnosticsPanelRow,
  type DiagnosticsPanelSeverity,
  type DiagnosticsPanelSource,
} from './diagnostics/diagnostics-view-model';

const SOURCES: readonly DiagnosticsPanelSource[] = ['trace', 'scan', 'assets', 'operationRuns', 'runtime'];
const SEVERITIES: readonly DiagnosticsPanelSeverity[] = ['error', 'warn', 'info'];

function useDiagnosticsRevision(): number {
  return useSyncExternalStore(
    subscribeDiagnosticsProjection,
    () => getDiagnosticsSnapshot().revision,
    () => 0,
  );
}

function actionLabel(action: DiagnosticsPanelAction): string {
  switch (action) {
    case 'locate': return 'Locate';
    case 'copy': return 'Copy details';
    case 'retry': return 'Retry';
    case 'open-source': return 'Open source';
  }
}

async function copyDetails(row: DiagnosticsPanelRow): Promise<boolean> {
  if (typeof navigator === 'undefined' || navigator.clipboard?.writeText === undefined) return false;
  try {
    await navigator.clipboard.writeText(formatDiagnosticsDetail(row));
    return true;
  } catch {
    return false;
  }
}

function DiagnosticsPanel({
  snapshot: runtimeSnapshot,
  dispatchRuntimeAction,
}: {
  readonly snapshot?: DiagnosticsSnapshot;
  readonly dispatchRuntimeAction?: (action: Exclude<DiagnosticsPanelAction, 'copy'>, row: DiagnosticsPanelRow) => void;
}) {
  const localRevision = useDiagnosticsRevision();
  const source = getDiagnosticsProjectionSource();
  const snapshot = runtimeSnapshot ?? getDiagnosticsSnapshot();
  const revision = runtimeSnapshot?.revision ?? localRevision;
  const rows = useMemo(() => buildDiagnosticsRows(snapshot), [snapshot]);
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<DiagnosticsPanelSource | ''>('');
  const [severityFilter, setSeverityFilter] = useState<DiagnosticsPanelSeverity | ''>('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const visibleRows = filterDiagnosticsRows(rows, {
    query,
    sources: sourceFilter === '' ? undefined : [sourceFilter],
    severities: severityFilter === '' ? undefined : [severityFilter],
  });

  const onAction = (action: DiagnosticsPanelAction, row: DiagnosticsPanelRow): void => {
    if (action === 'copy') {
      void copyDetails(row).then((copied) => setCopiedId(copied ? row.id : null));
      return;
    }
    if (dispatchRuntimeAction !== undefined) {
      dispatchRuntimeAction(action, row);
      return;
    }
    source.dispatchAction?.(action, row);
  };

  return (
    <section className="cap-diagnostics" data-testid="cap-diagnostics" data-revision={revision}>
      <div className="cap-diagnostics-header">
        <div>
          <h3>Diagnostics</h3>
          <span className="muted" data-testid="cap-diagnostics-count">{visibleRows.length} shown / {rows.length} total</span>
        </div>
        <span className="cap-diagnostics-policy" title="Gateway diagnostics snapshot revision">r{revision}</span>
      </div>
      <div className="cap-diagnostics-filters" role="search" aria-label="Filter diagnostics">
        <input
          type="search"
          value={query}
          placeholder="Filter diagnostics"
          aria-label="Filter diagnostics"
          data-testid="cap-diagnostics-filter"
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        <select
          value={sourceFilter}
          aria-label="Filter diagnostic source"
          data-testid="cap-diagnostics-source-filter"
          onChange={(event) => setSourceFilter(event.currentTarget.value as DiagnosticsPanelSource | '')}
        >
          <option value="">All sources</option>
          {SOURCES.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
        <select
          value={severityFilter}
          aria-label="Filter diagnostic severity"
          data-testid="cap-diagnostics-severity-filter"
          onChange={(event) => setSeverityFilter(event.currentTarget.value as DiagnosticsPanelSeverity | '')}
        >
          <option value="">All levels</option>
          {SEVERITIES.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </div>
      <div className="cap-diagnostics-list" data-testid="cap-diagnostics-list">
        {visibleRows.length === 0 ? (
          <div className="muted cap-diagnostics-empty" data-testid="cap-diagnostics-empty">No diagnostics</div>
        ) : visibleRows.map((row) => (
          <article className={`cap-diagnostic-row cap-diagnostic-${row.severity}`} key={row.id} data-testid="cap-diagnostic-row" data-source={row.source} data-severity={row.severity}>
            <div className="cap-diagnostic-main">
              <span className="cap-diagnostic-severity" aria-label={row.severity}>{row.severity}</span>
              <strong title={row.code}>{row.title}</strong>
              <span className="cap-diagnostic-source">{row.source}</span>
            </div>
            <div className="cap-diagnostic-message">{row.message}</div>
            <div className="cap-diagnostic-meta">
              <code>{row.code}</code>
              {row.path && <span>{row.path}</span>}
              {row.runId && <span>{row.runId}</span>}
              {row.traceId && <span>trace {row.traceId}</span>}
            </div>
            <details className="cap-diagnostic-details">
              <summary>Details</summary>
              <pre>{formatDiagnosticsDetail(row)}</pre>
            </details>
            <div className="cap-diagnostic-actions">
              {row.actions.map((action) => (
                <button
                  key={action}
                  type="button"
                  data-testid={`cap-diagnostic-action-${action}`}
                  disabled={action !== 'copy' && dispatchRuntimeAction === undefined && source.dispatchAction === undefined}
                  onClick={() => onAction(action, row)}
                >
                  {copiedId === row.id && action === 'copy' ? 'Copied' : actionLabel(action)}
                </button>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

interface RuntimeCapabilitiesProjection {
  readonly diagnostics: DiagnosticsSnapshot;
  readonly execution: ExecutionReport;
}

function isDiagnosticsSnapshot(value: unknown): value is DiagnosticsSnapshot {
  return value !== null
    && typeof value === 'object'
    && (value as { schemaVersion?: unknown }).schemaVersion === DIAGNOSTICS_SCHEMA_VERSION;
}

function useRuntimeCapabilitiesProjection(): RuntimeCapabilitiesProjection | undefined {
  const connection = useSyncExternalStore(
    subscribeViewportRuntimeClient,
    getViewportRuntimeClientSnapshot,
    getViewportRuntimeClientSnapshot,
  );
  const [projection, setProjection] = useState<RuntimeCapabilitiesProjection | undefined>();
  useEffect(() => {
    if (connection.status !== 'ready') {
      setProjection(undefined);
      return;
    }
    let disposed = false;
    let pending = false;
    const refresh = async (): Promise<void> => {
      if (pending) return;
      pending = true;
      try {
        const [diagnosticsEnvelope, executionEnvelope] = await Promise.all([
          queryViewportRuntimeProjection<DiagnosticsSnapshot>({ kind: 'diagnostics.snapshot' }),
          queryViewportRuntimeProjection<ExecutionReport>({ kind: 'engine.execution' }),
        ]);
        if (disposed) return;
        const diagnostics = diagnosticsEnvelope.status === 'ready' ? diagnosticsEnvelope.value : undefined;
        const execution = executionEnvelope.status === 'ready' ? executionEnvelope.value : undefined;
        if (!isDiagnosticsSnapshot(diagnostics) || !isExecutionReport(execution)) {
          setProjection(undefined);
          return;
        }
        setProjection({ diagnostics, execution });
      } catch {
        if (!disposed) setProjection(undefined);
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [connection.runtime?.runtimeGeneration, connection.runtime?.runtimeId, connection.status]);
  return projection;
}

function dispatchRuntimeDiagnosticAction(
  action: Exclude<DiagnosticsPanelAction, 'copy'>,
  row: DiagnosticsPanelRow,
): void {
  if (action === 'retry' && row.requestId !== undefined) {
    void retryViewportRuntimeOperationRun(row.requestId, crypto.randomUUID());
    return;
  }
  if (action === 'open-source' && row.path !== undefined) {
    void dispatchActiveEditorOperation({ kind: 'revealInFileManager', path: row.path });
    return;
  }
  if (action !== 'locate') return;
  const entityRef = row.objectRefs?.entity
    ?? (row.subjectRef?.kind === 'entity-handle' ? row.subjectRef : undefined);
  const entityId = Number(entityRef?.id ?? Number.NaN);
  if (Number.isSafeInteger(entityId)) {
    void dispatchActiveEditorOperation({ kind: 'setSelection', id: entityId });
    return;
  }
  if (row.location?.kind === 'file') {
    void dispatchActiveEditorOperation({
      kind: 'setFolderSelection',
      paths: [row.location.id],
      items: [{ path: row.location.id, kind: 'file' }],
    });
    return;
  }
  if (row.location?.kind !== 'asset') return;
  void queryViewportRuntimeProjection<{ readonly entries: readonly AssetBrowserRegistryEntry[] }>({ kind: 'assets.catalog' })
    .then((envelope) => {
      if (envelope.status !== 'ready') return;
      const asset = envelope.value.entries.find((candidate) => candidate.guid.toLowerCase() === row.location?.id.toLowerCase());
      if (asset === undefined) return;
      return dispatchActiveEditorOperation({
        kind: 'setAssetSelectionOne',
        asset: {
          guid: asset.guid,
          kind: asset.kind,
          name: asset.name ?? asset.guid,
          packPath: asset.sourcePath ?? asset.packageUrl,
        },
      });
    });
}

function EngineExecutionPanel({ report }: { readonly report: ExecutionReport | undefined }) {
  if (report === undefined) return null;
  const unavailable = EXECUTION_CAPABILITY_NAMES.filter((name) => !report.capabilities[name].available);
  return (
    <section
      className="cap-diagnostics"
      data-testid="cap-engine-execution"
      data-requested-tier={report.requestedTier}
      data-actual-tier={report.actualTier ?? 'pending'}
      data-engine-health={report.engine.health}
      data-world-health={report.world.health}
    >
      <div className="cap-diagnostics-header">
        <div>
          <h3>Engine execution</h3>
          <span className="muted">requested {report.requestedTier} · actual {report.actualTier ?? 'pending'}</span>
        </div>
        <span className="cap-diagnostics-policy">{report.selectionReason ?? 'selecting'}</span>
      </div>
      <div className="cap-diagnostic-meta">
        <span>engine {report.engine.health} ({report.engine.realm})</span>
        <span>world {report.world.health}</span>
        <span>shared evidence {report.sharedEvidencePassed ? 'passed' : 'not passed'}</span>
      </div>
      {unavailable.length > 0 && (
        <details className="cap-diagnostic-details">
          <summary>{unavailable.length} unavailable capabilities</summary>
          <ul>
            {unavailable.map((name) => (
              <li key={name}><code>{name}</code>: {report.capabilities[name].reason}</li>
            ))}
          </ul>
        </details>
      )}
      {report.fault !== null && <pre>{JSON.stringify(report.fault, null, 2)}</pre>}
    </section>
  );
}

// Capabilities panel — the component schema registry, the SAME source the
// Inspector reflects into widgets AND the AI bridge reflects into
// getComponentSchema. Showing it makes the editor's vocabulary legible: every
// component + field a human or AI can author. Read-only.
export function CapabilitiesPanel() {
  const schemas = listComponentSchemas();
  const runtime = useRuntimeCapabilitiesProjection();
  return (
    <div className="panel" data-testid="panel-capabilities">
      <h3>Capabilities</h3>
      <EngineExecutionPanel report={runtime?.execution} />
      <DiagnosticsPanel snapshot={runtime?.diagnostics} dispatchRuntimeAction={runtime === undefined ? undefined : dispatchRuntimeDiagnosticAction} />
      <div className="cap-list" data-testid="cap-list">
        {schemas.map((cs) => (
          <div className="cap-comp" key={cs.name} data-testid={`cap-${cs.name}`}>
            <div className="cap-name">{cs.name}</div>
            <div className="cap-fields">
              {cs.fields.map((f) => (
                <span className="cap-field" key={f.key} title={f.tooltip ?? ''}>
                  {f.key}<span className="cap-type">:{f.type}</span>
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
