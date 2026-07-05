// Blender-style workspace tabs — extracted from TopBar.tsx (architecture review
// §D: TopBar was a 1400-line god component). Each workspace is a named slot with
// its own saved dockview layout; switching saves the current layout and restores
// the target's. Core workspaces (Play/Edit/AI) are permanent; user-added ones
// can be renamed or deleted via the right-click menu.
import { useEffect, useReducer, useRef, useState, useLayoutEffect } from 'react';
import { Plus } from 'lucide-react';
import {
  loadWorkspaces,
  setActiveWorkspace,
  subscribeWorkspaces,
  addWorkspace,
  renameWorkspace,
  deleteWorkspace,
  CORE_WORKSPACE_IDS,
} from '../../lib/workspaces';
import { useTranslation } from '@/i18n';
import { FloatingMenu } from '../ui/FloatingMenu';
import { buildWorkspacePill, REFERENCE_LABEL, requestComposerInsert } from '../../lib/composer-bridge';

export function modeForWorkspace(id: string): 'edit' | 'workbench' {
  if (id === 'edit') return 'edit';
  // 'workbench' id AND all custom workspaces → plugin gallery, not the editor iframe
  return 'workbench';
}

export function WorkspaceTabs({ setMode }: { setMode: (m: 'edit' | 'workbench') => void }) {
  const { t } = useTranslation();
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeWorkspaces(bump), []);

  const { list, activeId } = loadWorkspaces();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const centerRef = useRef<HTMLDivElement>(null);
  const activeIdx = list.findIndex((w) => w.id === activeId);

  const [slider, setSlider] = useState<{ x: number; w: number } | null>(null);
  const [sliderReady, setSliderReady] = useState(false);
  // Inline rename state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);
  // Right-click context menu
  const [ctxMenu, setCtxMenu] = useState<{ wsId: string; x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const btn = tabRefs.current[activeIdx];
    const center = centerRef.current;
    if (!btn || !center) return;
    const bRect = btn.getBoundingClientRect();
    const cRect = center.getBoundingClientRect();
    setSlider({ x: bRect.left - cRect.left, w: bRect.width });
  }, [activeIdx, list.length]);

  useEffect(() => { if (slider !== null) setSliderReady(true); }, [slider]);
  useEffect(() => { if (editingId) editInputRef.current?.focus(); }, [editingId]);

  const switchTo = (id: string) => {
    setActiveWorkspace(id);
    setMode(modeForWorkspace(id));
  };

  const startRename = (id: string, name: string) => {
    setEditingId(id);
    setEditingName(name);
  };

  const commitRename = () => {
    if (editingId && editingName.trim()) renameWorkspace(editingId, editingName.trim());
    setEditingId(null);
  };

  const handleAdd = () => {
    const entry = addWorkspace();
    switchTo(entry.id);
  };

  const handleCtxMenu = (e: React.MouseEvent, wsId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ wsId, x: e.clientX, y: e.clientY });
  };

  const onTabKey = (idx: number) => (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const last = list.length - 1;
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = idx === 0 ? last : idx - 1;
    else if (e.key === 'ArrowRight') next = idx === last ? 0 : idx + 1;
    else return;
    e.preventDefault();
    const ws = list[next];
    if (ws) { switchTo(ws.id); requestAnimationFrame(() => tabRefs.current[next!]?.focus()); }
  };

  const ctxWs = ctxMenu ? list.find((w) => w.id === ctxMenu.wsId) : null;
  const ctxIsCore = ctxMenu ? CORE_WORKSPACE_IDS.has(ctxMenu.wsId) : false;

  return (
    <>
    <div className="tb-center" ref={centerRef} role="tablist" aria-label="Workspaces">
      {slider !== null && (
        <div className={`mode-tab-slider${sliderReady ? ' ready' : ''}`} aria-hidden="true"
          style={{ transform: `translateX(${slider.x}px)`, width: slider.w }} />
      )}
      {list.map((ws, idx) => {
        const isEditing = editingId === ws.id;
        const isActive = ws.id === activeId;
        if (isEditing) {
          // Render as div during rename — <input> inside <button> is invalid HTML
          // and causes focus to be stolen by the button on every keystroke.
          return (
            <div
              key={ws.id}
              className={`mode-tab${isActive ? ' active' : ''} ws-editing`}
            >
              <input
                ref={editInputRef}
                className="ws-rename-input"
                value={editingName}
                onChange={(e) => setEditingName(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                  if (e.key === 'Escape') { e.stopPropagation(); setEditingId(null); }
                }}
              />
            </div>
          );
        }
        return (
          <button
            key={ws.id}
            ref={(el) => { tabRefs.current[idx] = el; }}
            className={`mode-tab${isActive ? ' active' : ''}`}
            role="tab"
            aria-selected={isActive}
            tabIndex={idx === activeIdx ? 0 : -1}
            data-ws-id={ws.id}
            data-ws-name={ws.name}
            onClick={() => switchTo(ws.id)}
            onContextMenu={(e) => handleCtxMenu(e, ws.id)}
            onKeyDown={onTabKey(idx)}
          >
            {ws.name}
          </button>
        );
      })}
      <button className="ws-add-btn" title={t('workspaceTabs.addWorkspace')} onClick={handleAdd}>
        <Plus size={11} />
      </button>
    </div>
    {ctxMenu && ctxWs && (
      <FloatingMenu
        open
        onClose={() => setCtxMenu(null)}
        point={{ x: ctxMenu.x, y: ctxMenu.y }}
        className="ws-ctx-menu"
      >
        {!ctxIsCore && (
          <button
            className="ws-ctx-item"
            onClick={() => { startRename(ctxWs.id, ctxWs.name); setCtxMenu(null); }}
          >
            {t('workspaceTabs.rename')}
          </button>
        )}
        <button
          className="ws-ctx-item ws-ctx-item--send"
          onClick={() => { requestComposerInsert(buildWorkspacePill(ctxWs.id, ctxWs.name)); setCtxMenu(null); }}
        >
          {REFERENCE_LABEL}
        </button>
        {!ctxIsCore && <div className="ws-ctx-separator" />}
        {!ctxIsCore && (
          <button
            className="ws-ctx-item ws-ctx-item--danger"
            onClick={() => { deleteWorkspace(ctxWs.id); setCtxMenu(null); }}
          >
            {t('workspaceTabs.deleteWorkspace')}
          </button>
        )}
      </FloatingMenu>
    )}
    </>
  );
}
