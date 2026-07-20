// ProjectSwitcher (workspace/agentic-dir switcher) + its New/Open modal,
// extracted from TopBar.tsx (§D). The workspace activator lives in the shared
// lib/workspace-activate so first-run onboarding reuses the exact same flow.
import { useState, useEffect } from 'react';
import { FolderTree, FolderOpen, ChevronDown, Plus, Trash2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useTranslation } from '@/i18n';
import { useShellStore } from '../../store';
import { confirmDialog, alertDialog } from '../../lib/dialog';
import { setCurrentProject } from '../../lib/workbenches';
import { activateWorkspace } from '../../lib/workspace-activate';
import { reloadOnceForWorkspace } from '../../lib/workspace-reload';
import { FsBrowser } from './FsBrowser';
import './FsBrowser.css';
import './TopBar.css';

interface ProjectRow {
  id: string;
  path: string;
  absPath: string;
  displayName: string;
  isCurrent: boolean;
  hasGames: boolean;
  hasState: boolean;
  source: 'sibling' | 'registered';
}

type ModalTab = 'new' | 'open';

export function ProjectSwitcher() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [current, setCurrent] = useState<string>('');
  const [showNew, setShowNew] = useState(false);
  const [initialTab, setInitialTab] = useState<ModalTab>('new');
  const reload = async () => {
    try {
      const r = await fetch('/api/projects');
      const j = (await r.json()) as { projects?: ProjectRow[]; current?: string };
      setProjects(j.projects ?? []);
      setCurrent(j.current ?? '');
      // T7: propagate the active project id into the workbenches module so
      // every localStorage read/write namespaces under
      // `forgeax:project:${projId}:*`. Idempotent for the same id.
      setCurrentProject(j.current ?? 'default');
    } catch { /* ignore */ }
  };

  useEffect(() => {
    reload();
    const timer = setInterval(reload, 8000);
    return () => clearInterval(timer);
  }, []);

  const onDelete = async (row: ProjectRow) => {
    const confirmMsg = row.source === 'registered'
      ? t('projectSwitcher.removeRegisteredConfirm', { name: row.displayName, path: row.path })
      : t('projectSwitcher.deleteProjectConfirm', { id: row.id });
    if (!(await confirmDialog({ body: confirmMsg, danger: row.source !== 'registered' }))) return;
    try {
      const url = row.source === 'registered'
        ? `/api/projects/registered?path=${encodeURIComponent(row.absPath)}`
        : `/api/projects/${row.id}`;
      const r = await fetch(url, { method: 'DELETE' });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        void alertDialog({ body: (j as { error?: string }).error ?? `HTTP ${r.status}` });
        return;
      }
      reload();
    } catch (e) { void alertDialog({ body: (e as Error).message }); }
  };

  const [switching, setSwitching] = useState(false);
  const onSwitch = async (id: string) => {
    if (id === current) { setOpen(false); return; }
    const row = projects.find((p) => p.id === id);
    if (!row) return;
    setSwitching(true);
    try {
      await activateWorkspace({ path: row.absPath, initIfMissing: true });
      // Engine restart + symlink swap done server-side; full page reload
      // re-binds all UI state (chat / agents / preview iframe) to the new
      // workspace. activateWorkspace() already updated localStorage.forgeax.pinnedSlug
      // to the resolved activeSlug, seeded the workspace-changed dedup key, and
      // waited for the engine to settle — so this reloads once, against a healthy
      // engine (todo 005). reloadOnceForWorkspace() dedups vs the broadcast path.
      reloadOnceForWorkspace();
    } catch (e) {
      void alertDialog({ body: (e as Error).message });
      setSwitching(false);
    }
  };

  const openModal = (tab: ModalTab) => {
    setInitialTab(tab);
    setShowNew(true);
    setOpen(false);
  };

  const currentProject = projects.find((p) => p.isCurrent);

  return (
    <Popover open={open} onOpenChange={setOpen}>
    <div className="tb-game-switcher tb-project-switcher">
      <PopoverTrigger asChild>
        <button
          className="tb-game-btn"
          disabled={switching}
          title={t('projectSwitcher.triggerTooltip')}
        >
          <FolderTree size={16} />
          <span className="tb-game-label">{switching ? t('projectSwitcher.switching') : (currentProject?.displayName ?? current ?? '?')}</span>
          <ChevronDown size={16} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-auto border-0 bg-transparent p-0 shadow-none">
        <div className="tb-game-dropdown tb-game-dropdown--popover" style={{ minWidth: 280 }}>
          {/* Pinned "新建 workspace" at top — same form as GameSwitcher /
              SessionSwitcher's pinned create action. "打开已有目录" stays a
              secondary row at the bottom (no game/session analog). */}
          <button
            type="button"
            className="tb-game-pick"
            onClick={() => openModal('new')}
            style={{
              borderBottom: '1px solid var(--color-border-subtle)',
              color: 'var(--color-role-art)',
              position: 'sticky',
              top: -4,
              background: 'var(--bg-2)',
              zIndex: 1,
            }}
            title={t('projectSwitcher.newProjectTooltip')}
          >
            <Plus size={12} style={{ marginRight: 4 }} />
            <span className="tb-game-name">{t('projectSwitcher.newProject')}</span>
          </button>
          {projects.length === 0 && <div className="tb-game-empty">{t('projectSwitcher.empty')}</div>}
          {projects.map((p) => (
            <div key={`${p.source}:${p.absPath}`} className={`tb-game-row ${p.isCurrent ? 'active' : ''}`}>
              <button className="tb-game-pick" onClick={() => onSwitch(p.id)} title={p.absPath}>
                <span className="tb-game-name">
                  {p.displayName} {p.isCurrent && t('projectSwitcher.currentSuffix')}
                  {p.source === 'registered' && (
                    <span className="tb-game-source" title={t('projectSwitcher.extSourceTooltip')}>EXT</span>
                  )}
                </span>
                <span className="tb-game-meta">{p.hasGames ? 'games ✓ ' : ''}{p.hasState ? '.forgeax ✓' : ''}</span>
              </button>
              {p.isCurrent ? (
                <button className="tb-game-del" disabled title={t('projectSwitcher.deleteCurrentDisabledTooltip')}>
                  <Trash2 size={11} style={{ color: 'var(--color-icon-disabled)' }} />
                </button>
              ) : (
                <button
                  className="tb-game-del"
                  onClick={() => void onDelete(p)}
                  title={p.source === 'registered' ? t('projectSwitcher.removeFromListTooltip') : t('projectSwitcher.deleteProjectTooltip')}
                >
                  <Trash2 size={11} />
                </button>
              )}
            </div>
          ))}
          <button className="tb-game-row reset" onClick={() => openModal('open')}>
            <FolderOpen size={11} style={{ marginRight: 6 }} /> {t('projectSwitcher.openExisting')}
          </button>
        </div>
      </PopoverContent>
      {showNew && (
        <NewProjectModal
          initialTab={initialTab}
          onClose={() => { setShowNew(false); reload(); }}
          /* Opening / creating a workspace immediately activates it — the
             modal's submit handler already POSTs to /api/workspaces/activate
             and triggers location.reload(); nothing else to do here. */
          onOpened={() => { /* no-op */ }}
        />
      )}
    </div>
    </Popover>
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
