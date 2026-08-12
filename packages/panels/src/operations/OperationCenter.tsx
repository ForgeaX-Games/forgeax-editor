import { useSyncExternalStore, type ReactNode } from 'react';
import type { OperationCenterAction, OperationCenterRow } from './run-view-model';
import {
  getOperationCenterRows,
  getOperationProjectionSource,
  subscribeOperationProjection,
} from './run-view-model';
import { downloadOperationRun } from './run-export';

export interface OperationCenterProps {
  readonly onAction?: (action: OperationCenterAction, runId: string, row: OperationCenterRow) => void;
}

function useRows(): readonly OperationCenterRow[] {
  return useSyncExternalStore(
    subscribeOperationProjection,
    () => getOperationCenterRows(),
    () => [],
  );
}

function actionLabel(action: OperationCenterAction): string {
  switch (action) {
    case 'retry':
      return 'Retry';
    case 'cancel':
      return 'Cancel';
    case 'undo':
      return 'Undo';
    case 'inspect':
      return 'Inspect';
    case 'reveal-source':
      return 'Reveal source';
  }
}

function ActionButton({
  action,
  runId,
  row,
  onAction,
}: {
  readonly action: OperationCenterAction;
  readonly runId: string;
  readonly row: OperationCenterRow;
  readonly onAction?: OperationCenterProps['onAction'];
}): ReactNode {
  return (
    <button
      type="button"
      data-action={action}
      onClick={() => onAction?.(action, runId, row)}
    >
      {actionLabel(action)}
    </button>
  );
}

function formatResult(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const serialized = JSON.stringify(value);
    return serialized ?? String(value);
  } catch {
    return '[unserializable result]';
  }
}

function exportRun(runId: string): void {
  const source = getOperationProjectionSource();
  const run = source.getSnapshot().runs.find((candidate) => candidate.runId === runId);
  if (run === undefined) return;
  downloadOperationRun(run);
}

export function OperationCenter({ onAction }: OperationCenterProps): ReactNode {
  const subscribedRows = useRows();
  const visibleRows = subscribedRows;
  const source = getOperationProjectionSource();
  const dispatchAction = onAction ?? source.dispatchRecovery;
  const projectionRevision = String(source.getSnapshot().revision);
  return (
    <section
      className="panel operation-center"
      data-testid="operation-center"
      data-facts="product"
      data-projection-source="editor-product"
      data-revision={projectionRevision}
    >
      <div className="operation-center-header">
        <h3>Operation Center</h3>
        <span data-field="terminal-count">{visibleRows.filter((row) => row.isTerminal).length} terminal</span>
      </div>
      {visibleRows.length === 0 ? (
        <div className="muted" data-field="empty">
          <div>No operations</div>
          <div data-field="run-id">No active run</div>
          <div data-field="actor">No actor</div>
          <div data-field="progress">No progress</div>
          <div data-field="terminal">No terminal state</div>
        </div>
      ) : (
        <div className="operation-center-list">
          {visibleRows.map((row) => (
            <article className="operation-center-row" data-status={row.status} key={row.runId}>
              <div data-field="run-id">{row.runId}</div>
              <div data-field="request-id">{row.requestId ?? 'no requestId'}</div>
              <div data-field="actor">{row.actor.kind}:{row.actor.id}</div>
              <div data-field="parent-run">{row.parentRunId ?? 'root run'}</div>
              <div data-field="progress">{row.progress.stage} {Math.round(row.progress.fraction * 100)}%</div>
              <div data-field="terminal">{row.status}</div>
              {row.result !== undefined && <div data-field="result">{formatResult(row.result)}</div>}
              {row.error && <div data-field="error">{row.error.code}: {row.error.hint}</div>}
              {row.subject && (
                <div data-field="subject">
                  {row.subject.kind}
                  {row.subject.name ? ` ${row.subject.name}` : ''}
                  {row.subject.sceneGuid ? ` scene=${row.subject.sceneGuid}` : ''}
                  {row.subject.entity !== undefined ? ` entity=${row.subject.entity}` : ''}
                  {row.subject.component ? ` ${row.subject.component}.${row.subject.field ?? ''}` : ''}
                  {row.subject.assets.map((asset) => <span key={asset.guid} data-field="asset">{asset.name} ({asset.guid})</span>)}
                  {row.subject.cleanup && <span data-field="cleanup">cleanup={row.subject.cleanup.ok === undefined ? 'unknown' : row.subject.cleanup.ok ? 'succeeded' : 'failed'}</span>}
                </div>
              )}
              <div data-field="recoveryActions">
                {row.recoveryActions.map((action) => <span key={action}>{action}</span>)}
              </div>
              <div className="operation-center-actions">
                {row.actions.map((action) => (
                  <ActionButton key={action} action={action} runId={row.runId} row={row} onAction={dispatchAction} />
                ))}
                {row.isTerminal && (
                  <button
                    type="button"
                    data-action="export"
                    data-testid={`operation-run-export-${row.runId}`}
                    onClick={() => exportRun(row.runId)}
                  >
                    Export JSON
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
