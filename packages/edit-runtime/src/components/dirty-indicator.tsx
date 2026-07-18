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

import { useEffect, useState, type ReactNode } from 'react';
import { hasPendingDiskSave } from '@forgeax/editor-core';
import { useDocVersion } from '@forgeax/editor-core';

export function DirtyIndicator(): ReactNode {
  // useDocVersion re-renders on every command — so the dirty state is live.
  useDocVersion();
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    // Polling is cheap — hasPendingDiskSave reads the in-memory dirty flag.
    const check = () => setDirty(hasPendingDiskSave());
    check();
    const interval = setInterval(check, 500);
    return () => clearInterval(interval);
  }, []);

  return (
    <span
      data-testid="dirty-indicator"
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