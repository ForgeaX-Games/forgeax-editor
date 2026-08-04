import type { ReactNode } from 'react';
import {
  canDispatchSourceMutation,
  type SourceMutationAction,
  type SourceMutationViewModel,
} from './source-mutation-view-model';

export interface SourceMutationDialogProps {
  readonly viewModel: SourceMutationViewModel;
  readonly onAction: (action: SourceMutationAction) => void;
  readonly children?: ReactNode;
}

function scopeLabel(viewModel: SourceMutationViewModel): string {
  return 'all' in viewModel.impact.scope ? 'all source outputs' : viewModel.impact.scope.sourceKey;
}

function dispatchIfAllowed(
  viewModel: SourceMutationViewModel,
  action: SourceMutationAction,
  onAction: (action: SourceMutationAction) => void,
): void {
  if (canDispatchSourceMutation(viewModel, action)) onAction(action);
}

export function SourceMutationDialog({ viewModel, onAction, children }: SourceMutationDialogProps) {
  return (
    <section aria-label="Source mutation" data-testid="source-mutation-dialog">
      <header>
        <strong>{viewModel.guid}</strong>
        <span data-testid="source-lifecycle">{viewModel.lifecycle}</span>
      </header>
      <p data-testid="source-revision">Meta revision: {viewModel.impact.expectedRevision}</p>
      <p data-testid="source-impact">Impact scope: {scopeLabel(viewModel)}</p>
      <p>Source keys: {viewModel.impact.sourceKeys.join(', ') || 'none'}</p>
      <p>Affected GUIDs: {viewModel.impact.affectedGuids.join(', ') || 'none'}</p>
      <p>Referencer GUIDs: {viewModel.impact.referencerGuids.join(', ') || 'none'}</p>
      <p>Scene instances: {viewModel.impact.instanceGuids.join(', ') || 'none'}</p>
      {viewModel.lastKnownGood !== undefined && <p data-testid="source-lkg">Last known good: {viewModel.lastKnownGood}</p>}
      {viewModel.errorCode !== undefined && <p data-testid="source-error">{viewModel.errorCode}: {viewModel.errorHint}</p>}
      {viewModel.recoveryActions.length > 0 && <p data-testid="source-recovery">Recovery: {viewModel.recoveryActions.join(', ')}</p>}
      <div>
        <button
          data-testid="source-reimport"
          type="button"
          disabled={!viewModel.canReimport}
          onClick={() => dispatchIfAllowed(viewModel, 'reimport', onAction)}
        >
          Reimport and keep overrides
        </button>
        <button
          data-testid="source-discard"
          type="button"
          disabled={!viewModel.canDiscard}
          onClick={() => dispatchIfAllowed(viewModel, 'discard', onAction)}
        >
          Discard overrides and reimport
        </button>
        <button
          data-testid="source-retry"
          type="button"
          disabled={!canDispatchSourceMutation(viewModel, 'retry')}
          onClick={() => dispatchIfAllowed(viewModel, 'retry', onAction)}
        >
          Retry
        </button>
        <button
          data-testid="source-reconcile"
          type="button"
          disabled={!canDispatchSourceMutation(viewModel, 'reconcile')}
          onClick={() => dispatchIfAllowed(viewModel, 'reconcile', onAction)}
        >
          Reconcile
        </button>
      </div>
      {children}
    </section>
  );
}
