import { useSyncExternalStore, type ReactNode } from 'react';
import type { OperationCenterAction, OperationCenterRow } from './run-view-model';
import {
  getOperationCenterRows,
  getOperationProjectionSource,
  subscribeOperationProjection,
} from './run-view-model';

export interface OperationCenterProps {
  readonly onAction?: (action: OperationCenterAction, runId: string) => void;
}

function useRows(): readonly OperationCenterRow[] {
  return useSyncExternalStore(
    subscribeOperationProjection,
    () => getOperationCenterRows(),
    () => [],
  );
}

function ActionButton({
  action,
  runId,
  onAction,
}: {
  readonly action: OperationCenterAction;
  readonly runId: string;
  readonly onAction?: OperationCenterProps['onAction'];
}): ReactNode {
  return (
    <button
      type="button"
      data-action={action}
      onClick={() => onAction?.(action, runId)}
    >
      {action}
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
              <div data-field="recoveryActions">
                {row.recoveryActions.map((action) => <span key={action}>{action}</span>)}
              </div>
              <div className="operation-center-actions">
                {row.actions.map((action) => (
                  <ActionButton key={action} action={action} runId={row.runId} onAction={dispatchAction} />
                ))}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
