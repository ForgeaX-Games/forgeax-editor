// Workspace new/open modal + headless project-id sync.
//
// 2026-07-23 — the ProjectSwitcher dropdown (trigger + project list +
// current-name + delete) was removed from the TopBar. 新建/打开 moved into the
// File menu (commands `project.new` / `project.open` → `openProjectModal`), and
// switching to another workspace is done via File → 打开项目 (the modal's Open
// tab picks any directory and activates it). This file now exports:
//   - `ProjectModalHost`: renders <NewProjectModal> when the shell store's
//     `projectModalTab` is set, and runs the headless project-id sync.
//   - `NewProjectModal` stays internal to this file.
import { useState, useEffect } from 'react';
import { useTranslation } from '@/i18n';
import { useShellStore } from '../../store';
import { setCurrentProject } from '../../lib/workbenches';
import { activateWorkspace } from '../../lib/workspace-activate';
import { reloadOnceForWorkspace } from '../../lib/workspace-reload';
import { FsBrowser } from './FsBrowser';
import './FsBrowser.css';
import './TopBar.css';

type ModalTab = 'new' | 'open';

// Headless: keep the active project id in sync so every localStorage read/write
// namespaces under `forgeax:project:${projId}:*` (was previously driven by the
// ProjectSwitcher's polling). Idempotent for the same id.
function useProjectIdSync(): void {
  useEffect(() => {
    let cancelled = false;
    const sync = async () => {
      try {
        const r = await fetch('/api/projects');
        const j = (await r.json()) as { current?: string };
        if (!cancelled) setCurrentProject(j.current ?? 'default');
      } catch { /* ignore */ }
    };
    void sync();
    const timer = setInterval(() => void sync(), 8000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);
}

// Mounted once in the shell (App.tsx). Drives the workspace new/open modal from
// the File-menu commands and runs the project-id sync.
export function ProjectModalHost() {
  useProjectIdSync();
  const tab = useShellStore((s) => s.projectModalTab);
  const closeProjectModal = useShellStore((s) => s.closeProjectModal);
  if (!tab) return null;
  return (
    <NewProjectModal
      initialTab={tab}
      onClose={closeProjectModal}
      /* Creating / opening a workspace immediately activates it — the modal's
         submit handler POSTs to /api/workspaces/activate and triggers a reload;
         nothing else to do here. */
      onOpened={() => { /* no-op */ }}
    />
  );
}

interface NewProjectModalProps {
  initialTab: ModalTab;
  onClose: () => void;
  /** Fired after successful POST /api/projects/open — parent shows restart hint. */
  onOpened: (absPath: string) => void;
}

function NewProjectModal({ initialTab, onClose, onOpened }: NewProjectModalProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<ModalTab>(initialTab);
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submitNew = async () => {
    const cleaned = id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    if (!/^[a-z0-9][a-z0-9-_]{1,40}$/.test(cleaned)) {
      setErr(t('projectSwitcher.idError'));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      // 1) create the sibling dir + scaffold
      const r = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: cleaned, displayName: name.trim() || cleaned }),
      });
      const j = (await r.json()) as { ok?: boolean; error?: string; absDir?: string };
      if (!r.ok || !j.ok) { setErr(j.error ?? `HTTP ${r.status}`); setBusy(false); return; }
      // 2) immediately activate the new workspace
      await activateWorkspace({ path: j.absDir ?? '', initIfMissing: true });
      reloadOnceForWorkspace();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  const submitOpen = async (absPath: string, initIfMissing: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      await activateWorkspace({ path: absPath, initIfMissing });
      onClose();
      onOpened(absPath);
      reloadOnceForWorkspace();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  const wide = tab === 'open';

  return (
    <div className="tb-modal-overlay" onClick={onClose}>
      <div className={`tb-modal ${wide ? 'tb-modal-wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="tb-modal-title">workspace</div>
        <div className="tb-modal-tabs" role="tablist">
          <button
            className={`tb-modal-tab ${tab === 'new' ? 'active' : ''}`}
            onClick={() => { setTab('new'); setErr(null); }}
          >{t('projectSwitcher.tabNew')}</button>
          <button
            className={`tb-modal-tab ${tab === 'open' ? 'active' : ''}`}
            onClick={() => { setTab('open'); setErr(null); }}
          >{t('projectSwitcher.tabOpen')}</button>
        </div>

        {tab === 'new' && (
          <>
            <label className="tb-modal-label">{t('projectSwitcher.idLabel')}</label>
            <input
              autoFocus
              className="tb-modal-input"
              placeholder="e.g. my-game-workspace"
              value={id}
              onChange={(e) => setId(e.target.value)}
            />
            <label className="tb-modal-label">{t('projectSwitcher.displayNameLabel')}</label>
            <input
              className="tb-modal-input"
              placeholder={t('projectSwitcher.displayNamePlaceholder')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            {err && <div className="tb-modal-error">{err}</div>}
            <div className="tb-modal-actions">
              <button className="tb-modal-btn" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
              <button className="tb-modal-btn primary" onClick={submitNew} disabled={busy}>
                {busy ? t('projectSwitcher.creating') : t('projectSwitcher.create')}
              </button>
            </div>
          </>
        )}

        {tab === 'open' && (
          <FsBrowser
            onPick={submitOpen}
            onCancel={onClose}
            busy={busy}
            externalError={err}
          />
        )}
      </div>
    </div>
  );
}

// SessionSwitcher extracted → ./SessionSwitcher (§D).
