import { useMemo, useSyncExternalStore, type ReactElement } from 'react';
import { gateway } from '@forgeax/editor-core';
import {
  assertOperationsPageReadOnly,
  getOperationsObserverSnapshot,
  projectOperationsPage,
  subscribeOperationsObserver,
} from './operations-projection';

function useProjection() {
  const snapshot = useSyncExternalStore(
    subscribeOperationsObserver,
    getOperationsObserverSnapshot,
    () => ({ revision: 0, runs: [] }),
  );
  return useMemo(() => projectOperationsPage(snapshot), [snapshot]);
}

export function OperationsPage(): ReactElement {
  const projection = useProjection();
  const readOnly = assertOperationsPageReadOnly(['open-resource']);
  const openResource = (guid: string): void => {
    const asset = gateway.assetCatalog().find((candidate) => candidate.guid.toLowerCase() === guid.toLowerCase());
    if (asset === undefined) return;
    gateway.dispatch({
      kind: 'openAssetEditor',
      asset: { guid: asset.guid, kind: asset.kind, name: asset.name ?? asset.guid, packPath: asset.sourcePath ?? asset.guid },
    }, 'human');
  };
  return (
    <main className="operations-page" data-testid="operations-page" data-revision={projection.revision} data-read-only={String(readOnly.ok)}>
      <header className="operations-page-header">
        <h2>AI Operations</h2>
        <span data-testid="operations-page-authority">observer-only</span>
        <span data-testid="operations-page-run-count">{projection.runs.length} runs</span>
      </header>
      <section data-testid="operations-page-runs" aria-live="polite">
        {projection.runs.length === 0 && <div data-testid="operations-page-empty">No private runs</div>}
        {projection.runs.map((run) => (
          <article key={run.runId} data-testid="operations-page-run" data-run-id={run.runId} data-status={run.terminal?.status ?? 'running'}>
            <div data-field="request-id">request={run.requestId ?? 'none'}</div>
            <div data-field="operation-id">operation={run.operationId}</div>
            <div data-field="actor">actor={run.actor.kind}:{run.actor.id}</div>
            <div data-field="subject">subject={run.subject?.kind ?? 'none'}:{run.subject?.guid ?? 'none'}</div>
            <div data-field="snapshot">snapshot={run.snapshot?.revision ?? 'none'}:{run.snapshot?.digest ?? 'none'}</div>
            <div data-field="progress">{run.progress.stage} {Math.round(run.progress.fraction * 100)}%</div>
            <div data-field="terminal">terminal={run.terminal?.status ?? 'pending'}</div>
            <div data-field="artifacts">artifacts={run.artifacts.length}</div>
            <div data-field="diagnostics">diagnostics={run.diagnostics.length}</div>
            {run.controls.map((control) => (
              <button key={`${control.kind}:${control.guid}`} type="button" data-action={control.kind} onClick={() => openResource(control.guid)}>
                Open resource
              </button>
            ))}
          </article>
        ))}
      </section>
    </main>
  );
}

export default OperationsPage;
