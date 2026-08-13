import { useState, useSyncExternalStore, type ChangeEvent, type ReactNode } from 'react';
import type { OperationCenterAction, OperationCenterRow } from './run-view-model';
import {
  getOperationCenterRows,
  getOperationProjectionSource,
  subscribeOperationProjection,
} from './run-view-model';
import { downloadOperationRun } from './run-export';
import {
  projectProfileComparison,
  type ProfileComparisonPhaseFact,
  type ProfileComparisonProjection,
  type ProfileComparisonSide,
} from '../operation-projection';

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

function formatMetric(value: number | null | undefined): string {
  return value === undefined || value === null ? 'unavailable' : String(value);
}

function formatPhaseIdentity(
  identity: ProfileComparisonProjection['phases'][number]['identity'],
): string {
  const parent = identity.parentPhase === undefined
    ? ''
    : ` parent=${identity.parentSource ?? identity.source}:${identity.parentPhase}`;
  return `${identity.source}:${identity.phase}${parent}`;
}

function renderPhaseFact(
  side: 'left' | 'right',
  fact: ProfileComparisonPhaseFact | undefined,
): ReactNode {
  return (
    <div data-side={side}>
      <span data-field="count">count={formatMetric(fact?.count)}</span>
      <span data-field="skip-count">skips={formatMetric(fact?.skipCount)}</span>
      <span data-field="p95-duration">p95µs={formatMetric(fact?.p95DurationMicros)}</span>
    </div>
  );
}

function renderCompleteness(side: ProfileComparisonSide): ReactNode {
  const completeness = side.summary?.completeness;
  if (completeness === undefined) return <span data-field="completeness">unavailable</span>;
  return (
    <span data-field="completeness">
      <span data-field="completeness-status">{completeness.status}</span>
      <span data-field="retained-events"> retained={completeness.retainedEventCount}</span>
      <span data-field="dropped-events"> dropped={completeness.droppedEventCount}</span>
      {completeness.incompleteReason !== undefined && (
        <span data-field="incomplete-reason"> reason={completeness.incompleteReason}</span>
      )}
      {completeness.firstAffectedFrameId !== undefined && (
        <span data-field="first-affected-frame"> firstAffected={completeness.firstAffectedFrameId}</span>
      )}
      {completeness.lastAffectedFrameId !== undefined && (
        <span data-field="last-affected-frame"> lastAffected={completeness.lastAffectedFrameId}</span>
      )}
    </span>
  );
}

function ProfileComparisonSideView({
  label,
  side,
}: {
  readonly label: 'Left' | 'Right';
  readonly side: ProfileComparisonSide;
}): ReactNode {
  const summary = side.summary;
  return (
    <section data-testid={`profile-compare-${label.toLowerCase()}`} data-side={label.toLowerCase()}>
      <h5>{label} artifact</h5>
      <div data-field="run-id">run={side.run?.runId ?? 'unavailable'}</div>
      <div data-field="operation-id">operation={side.run?.operationId ?? 'unavailable'}</div>
      <div data-field="status">status={side.run?.status ?? 'unavailable'}</div>
      {summary === undefined ? (
        <div data-field="summary">summary=unavailable</div>
      ) : (
        <>
          <div data-field="capture-id">capture={summary.captureId}</div>
          <div data-field="time-unit">unit={summary.timeUnit}</div>
          <div data-field="frame-count">frames={summary.frameCount}</div>
          <div data-field="record-count">records={summary.recordCount}</div>
          <div data-field="phase-count">phases={summary.phaseCount}</div>
          <div data-field="skip-count">skips={summary.skipCount}</div>
          <div data-field="p95-duration">p95µs={formatMetric(summary.p95DurationMicros)}</div>
        </>
      )}
      {renderCompleteness(side)}
      {side.error !== undefined && (
        <div data-field="comparison-error">
          {side.error.code}: {side.error.hint}
          {'issues' in side.error.detail && side.error.detail.issues?.join(' ')}
          {'path' in side.error.detail && ` ${side.error.detail.path}: ${side.error.detail.message}`}
        </div>
      )}
    </section>
  );
}

function ProfileComparisonView({ projection }: { readonly projection: ProfileComparisonProjection }): ReactNode {
  return (
    <div data-testid="profile-compare-result">
      <div className="profile-compare-sides">
        <ProfileComparisonSideView label="Left" side={projection.left} />
        <ProfileComparisonSideView label="Right" side={projection.right} />
      </div>
      <div data-testid="profile-compare-phases">
        <h5>Phase comparison</h5>
        {projection.phases.length === 0 ? (
          <div data-field="empty">No comparable phases</div>
        ) : projection.phases.map((phase, index) => (
          <div
            className="profile-compare-phase"
            data-testid={`profile-compare-phase-${index}`}
            key={`${formatPhaseIdentity(phase.identity)}-${index}`}
          >
            <div data-field="identity">{formatPhaseIdentity(phase.identity)}</div>
            {renderPhaseFact('left', phase.left)}
            {renderPhaseFact('right', phase.right)}
            <div data-side="delta">
              <span data-field="count">delta-count={formatMetric(phase.delta?.count)}</span>
              <span data-field="skip-count">delta-skips={formatMetric(phase.delta?.skipCount)}</span>
              <span data-field="p95-duration">delta-p95µs={formatMetric(phase.delta?.p95DurationMicros)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProfileComparisonControl(): ReactNode {
  const [inputs, setInputs] = useState<{ readonly left?: unknown; readonly right?: unknown }>({});
  const [fileError, setFileError] = useState<string | undefined>();
  const projection = inputs.left === undefined || inputs.right === undefined
    ? undefined
    : projectProfileComparison(inputs.left, inputs.right);

  async function onArtifactChange(
    side: 'left' | 'right',
    event: ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (file === undefined) return;
    try {
      const value = JSON.parse(await file.text()) as unknown;
      setInputs((current) => ({ ...current, [side]: value }));
      setFileError(undefined);
    } catch {
      setFileError(`${side} artifact is not valid JSON.`);
    }
  }

  return (
    <section className="profile-comparison" data-testid="profile-comparison">
      <h4>Compare exported OperationRuns</h4>
      <label>
        Left artifact
        <input
          type="file"
          accept="application/json,.json"
          data-testid="profile-compare-left-input"
          onChange={(event) => void onArtifactChange('left', event)}
        />
      </label>
      <label>
        Right artifact
        <input
          type="file"
          accept="application/json,.json"
          data-testid="profile-compare-right-input"
          onChange={(event) => void onArtifactChange('right', event)}
        />
      </label>
      {fileError !== undefined && <div data-field="file-error">{fileError}</div>}
      {projection === undefined ? (
        <div data-field="comparison-empty">Select two exported OperationRun JSON files.</div>
      ) : (
        <ProfileComparisonView projection={projection} />
      )}
    </section>
  );
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
      <ProfileComparisonControl />
    </section>
  );
}
