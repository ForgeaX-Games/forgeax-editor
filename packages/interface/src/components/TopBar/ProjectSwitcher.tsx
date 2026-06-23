// ProjectSwitcher (workspace/agentic-dir switcher) + its New/Open modal,
// extracted from TopBar.tsx (§D). activateWorkspace() lives here too since both
// the switcher and the modal call it.
import { useState, useEffect } from 'react';
import { FolderTree, FolderOpen, ChevronDown, Plus, Trash2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useAppStore } from '../../store';
import { confirmDialog, alertDialog } from '../../lib/dialog';
import { STORAGE_KEYS } from '../../lib/storageKeys';
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
    } catch { /* ignore */ }
  };

  useEffect(() => {
    reload();
    const t = setInterval(reload, 8000);
    return () => clearInterval(t);
  }, []);

  const onDelete = async (row: ProjectRow) => {
    const confirmMsg = row.source === 'registered'
      ? `从已知列表中移除 "${row.displayName}"？\n\n仅会从 ~/.forgeax/known-projects.json 中摘除条目，磁盘上的目录 ${row.path} 不会被删除。`
      : `确认删除 project ${row.id}/ ？此操作会删除整个工作目录（games + .forgeax）。`;
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
      await activateWorkspace(row.absPath, true);
      // Engine restart + symlink swap done server-side; full page reload
      // re-binds all UI state (chat / agents / preview iframe) to the new
      // workspace. activateWorkspace() already updated localStorage.forgeax.pinnedSlug
      // to the resolved activeSlug so the post-reload iframe points at a real game.
      window.location.reload();
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
          title="workspace（agentic 工作目录）· 切换会热重启 engine + cli"
        >
          <FolderTree size={16} />
          <span className="tb-game-label">{switching ? '切换中…' : (currentProject?.displayName ?? current ?? '?')}</span>
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
            title="新建一个 workspace（agentic 工作目录）"
          >
            <Plus size={12} style={{ marginRight: 4 }} />
            <span className="tb-game-name">新建 workspace</span>
          </button>
          {projects.length === 0 && <div className="tb-game-empty">暂无 project</div>}
          {projects.map((p) => (
            <div key={`${p.source}:${p.absPath}`} className={`tb-game-row ${p.isCurrent ? 'active' : ''}`}>
              <button className="tb-game-pick" onClick={() => onSwitch(p.id)} title={p.absPath}>
                <span className="tb-game-name">
                  {p.displayName} {p.isCurrent && '· 当前'}
                  {p.source === 'registered' && (
                    <span className="tb-game-source" title="来自 ~/.forgeax/known-projects.json">EXT</span>
                  )}
                </span>
                <span className="tb-game-meta">{p.hasGames ? 'games ✓ ' : ''}{p.hasState ? '.forgeax ✓' : ''}</span>
              </button>
              {p.isCurrent ? (
                <button className="tb-game-del" disabled title="无法删除当前项目（先切换到其他项目）">
                  <Trash2 size={11} style={{ color: 'var(--color-icon-disabled)' }} />
                </button>
              ) : (
                <button
                  className="tb-game-del"
                  onClick={() => void onDelete(p)}
                  title={p.source === 'registered' ? '从已知列表移除（不删目录）' : '删除项目'}
                >
                  <Trash2 size={11} />
                </button>
              )}
            </div>
          ))}
          <button className="tb-game-row reset" onClick={() => openModal('open')}>
            <FolderOpen size={11} style={{ marginRight: 6 }} /> 打开已有目录
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

/**
 * Shared workspace activator — POST /api/workspaces/activate and re-pin
 * localStorage.forgeax.pinnedSlug to the server-resolved activeSlug, so the
 * post-reload iframe lands on a real game rather than whatever slug the OLD
 * workspace had pinned.
 */
async function activateWorkspace(absPath: string, initIfMissing: boolean) {
  const r = await fetch('/api/workspaces/activate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: absPath, initIfMissing }),
  });
  const j = (await r.json()) as { ok?: boolean; error?: string; absPath?: string; activeSlug?: string };
  if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  try {
    if (j.activeSlug) localStorage.setItem(STORAGE_KEYS.pinnedSlug, j.activeSlug);
    else localStorage.removeItem(STORAGE_KEYS.pinnedSlug);
  } catch { /* ignore quota / disabled storage */ }
  return j;
}

function NewProjectModal({ initialTab, onClose, onOpened }: NewProjectModalProps) {
  const [tab, setTab] = useState<ModalTab>(initialTab);
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submitNew = async () => {
    const cleaned = id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    if (!/^[a-z0-9][a-z0-9-_]{1,40}$/.test(cleaned)) {
      setErr('id: 2-41 字符 / lowercase ascii / 数字 / -_');
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
      await activateWorkspace(j.absDir ?? '', true);
      window.location.reload();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  const submitOpen = async (absPath: string, initIfMissing: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      await activateWorkspace(absPath, initIfMissing);
      onClose();
      onOpened(absPath);
      window.location.reload();
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
          >新建项目</button>
          <button
            className={`tb-modal-tab ${tab === 'open' ? 'active' : ''}`}
            onClick={() => { setTab('open'); setErr(null); }}
          >打开已有目录</button>
        </div>

        {tab === 'new' && (
          <>
            <label className="tb-modal-label">id (工作目录名)</label>
            <input
              autoFocus
              className="tb-modal-input"
              placeholder="e.g. my-game-workspace"
              value={id}
              onChange={(e) => setId(e.target.value)}
            />
            <label className="tb-modal-label">显示名（可选）</label>
            <input
              className="tb-modal-input"
              placeholder="留空用 id"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            {err && <div className="tb-modal-error">{err}</div>}
            <div className="tb-modal-actions">
              <button className="tb-modal-btn" onClick={onClose} disabled={busy}>取消</button>
              <button className="tb-modal-btn primary" onClick={submitNew} disabled={busy}>
                {busy ? '创建中...' : '创建'}
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
