// dirty-indicator.tsx — editor toolbar dirty (unsaved-changes) indicator (M5 w27).
//
// Renders a colored dot in the editor toolbar that is colored (e.g. orange/yellow)
// when the authored document has unsaved edits (memory state differs from the
// on-disk pack), and grey when clean. Data source: hasPendingDiskSave() from
// editor-core store.ts.
//
// M6 w36 replaced the auto-save debounce with the manual-save dirty flag
// (`_isDirty`): every edit marks dirty; a successful save (user clicks Save, which
// dispatches the saveDocToDisk op) clears it. hasPendingDiskSave() returns that
// flag, so this indicator
// shows pending-vs-saved state under the manual-save model (D-7).
//
// Anchors:
//   requirements AC-14 human: dirty indicator visible in toolbar
//   requirements-decisions #5: manual-save — dirty indicator shows pending state
//   plan-strategy D-7: store.ts isDirty/hasPendingDiskSave semantics

import { useSyncExternalStore, type ReactNode } from 'react';
import { gateway, hasPendingDiskSave } from '@forgeax/editor-core';
import { projectSaveEntry } from '../save-operation-projection';

let projectionRevision = 0;
const projectionListeners = new Set<() => void>();
gateway.subscribe((_doc, command) => {
  if (command === null) return;
  projectionRevision += 1;
  for (const listener of projectionListeners) listener();
});
gateway.subscribeOperationRuns(() => {
  projectionRevision += 1;
  for (const listener of projectionListeners) listener();
});

function subscribeProjection(listener: () => void): () => void {
  projectionListeners.add(listener);
  return () => projectionListeners.delete(listener);
}

function getProjectionRevision(): number {
  return projectionRevision;
}

export function DirtyIndicator(): ReactNode {
  useSyncExternalStore(subscribeProjection, getProjectionRevision, getProjectionRevision);
  const projection = projectSaveEntry({
    run: gateway.operationRuns.listRuns().at(-1),
    dirty: hasPendingDiskSave(),
  });
  const dirty = projection.dirty;

  return (
    <span
      data-testid="dirty-indicator"
      data-save-status={projection.status}
      data-save-dirty-state={projection.dirtyState}
      data-save-request-id={projection.requestId ?? ''}
      title={dirty ? 'Unsaved changes — press Save (⌘S)' : 'All changes saved'}
      style={{
        display: 'inline-block',
        width: 10,
        height: 10,
        borderRadius: '50%',
        backgroundColor: dirty ? 'var(--accent-warn, #f90)' : 'var(--fg3, #666)',
        transition: 'background-color 0.2s',
        cursor: 'default',
      }}
    />
  );
}
