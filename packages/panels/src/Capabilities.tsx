import { useMemo, useState, useSyncExternalStore } from 'react';
import { listComponentSchemas } from '@forgeax/editor-core';
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

function DiagnosticsPanel() {
  const revision = useDiagnosticsRevision();
  const source = getDiagnosticsProjectionSource();
  const snapshot = getDiagnosticsSnapshot();
  const rows = useMemo(() => buildDiagnosticsRows(snapshot), [revision]);
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
                  disabled={action !== 'copy' && source.dispatchAction === undefined}
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

// Capabilities panel — the component schema registry, the SAME source the
// Inspector reflects into widgets AND the AI bridge reflects into
// getComponentSchema. Showing it makes the editor's vocabulary legible: every
// component + field a human or AI can author. Read-only.
export function CapabilitiesPanel() {
  const schemas = listComponentSchemas();
  return (
    <div className="panel" data-testid="panel-capabilities">
      <h3>Capabilities</h3>
      <DiagnosticsPanel />
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
