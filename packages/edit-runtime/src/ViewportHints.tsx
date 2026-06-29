import { useState } from 'react';
import { useTranslation } from '@forgeax/editor-shared/i18n';

// Dismissible controls cheat-sheet pinned to the bottom of the viewport. Lists
// the Blender-default camera + gizmo bindings. Closing it persists to
// localStorage (stays closed across sessions); a small "?" pill brings it back.
const KEY = 'forgeax:editor:hints-dismissed';

export function ViewportHints() {
  const { t } = useTranslation();
  const [open, setOpen] = useState<boolean>(() => {
    try { return localStorage.getItem(KEY) !== '1'; } catch { return true; }
  });

  const dismiss = (): void => {
    setOpen(false);
    try { localStorage.setItem(KEY, '1'); } catch { /* storage off */ }
  };
  const reopen = (): void => {
    setOpen(true);
    try { localStorage.removeItem(KEY); } catch { /* storage off */ }
  };

  if (!open) {
    return (
      <button type="button" className="vp-hints-toggle" data-testid="viewport-hints-toggle"
        title={t('editor.viewportHints.toggleTitle')} onClick={reopen}>?</button>
    );
  }

  return (
    <div className="vp-hints" data-testid="viewport-hints">
      <div className="vp-hints-rows">
        {/* Static, fully-controlled cheat-sheet strings from our own catalog —
            the only markup is <b> keycaps, so dangerouslySetInnerHTML is safe. */}
        <span className="vp-hints-row" dangerouslySetInnerHTML={{ __html: t('editor.viewportHints.row1') }} />
        <span className="vp-hints-row" dangerouslySetInnerHTML={{ __html: t('editor.viewportHints.row2') }} />
      </div>
      <button type="button" className="vp-hints-close" data-testid="viewport-hints-close"
        title={t('editor.viewportHints.closeTitle')} onClick={dismiss}>×</button>
    </div>
  );
}
