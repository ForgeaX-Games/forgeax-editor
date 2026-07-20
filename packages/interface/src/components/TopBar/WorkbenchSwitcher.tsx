// Blender-style workspace tabs — extracted from TopBar.tsx (architecture review
// §D: TopBar was a 1400-line god component). Each workspace is a named slot with
// its own saved dockview layout; switching saves the current layout and restores
// the target's. Core workspaces (Play/Edit/AI) are permanent; user-added ones
// can be renamed or deleted via the right-click menu.
import { useEffect, useReducer, useRef, useState, useLayoutEffect } from 'react';
import { Plus, Pencil, Bot, Layers } from 'lucide-react';
import {
  loadWorkbenchList,
  setActiveWorkbench,
  subscribeWorkbenchList,
  addWorkbench,
  renameWorkbench,
  deleteWorkbench,
  duplicateWorkbench,
  BUILTIN_WORKBENCH_IDS,
} from '../../lib/workbenches';
import { BUILTIN_WORKBENCHES } from '../DockShell/builtinWorkbenches';
import { useTranslation } from '@/i18n';
import { FloatingMenu } from '../ui/FloatingMenu';
import { buildWorkspacePill, REFERENCE_LABEL, requestComposerInsert } from '../../lib/composer-bridge';

// P3.5 · Icon rendered before the tab label. Built-ins carry their canonical
// icon in BUILTIN_WORKBENCHES[id].icon ('pencil' | 'bot'); custom workbenches
// fall back to Layers (generic "stack of tabs" glyph) so user-created entries
// are visually distinguishable from the two built-in staples at a glance.
const ICON_MAP: Record<string, React.ComponentType<{ size?: number }>> = {
  pencil: Pencil,
  bot: Bot,
};

function IconForWorkbench({ id, iconOverride }: { id: string; iconOverride?: string }) {
  const iconName = iconOverride ?? BUILTIN_WORKBENCHES[id]?.icon;
  const Icon = iconName ? ICON_MAP[iconName] : Layers;
  return <Icon size={12} />;
}

export function modeForWorkbench(id: string): 'scene' | 'ai' {
  if (id === 'scene') return 'scene';
  // 'ai' id AND all custom workspaces → plugin gallery, not the editor iframe
  return 'ai';
}

export function WorkbenchSwitcher({ setMode }: { setMode: (m: 'scene' | 'ai') => void }) {
  const { t } = useTranslation();
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeWorkbenchList(bump), []);

  const { list, activeId } = loadWorkbenchList();
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
    setActiveWorkbench(id);
    setMode(modeForWorkbench(id));
  };

  const startRename = (id: string, name: string) => {
    setEditingId(id);
    setEditingName(name);
  };

  const commitRename = () => {
    if (editingId && editingName.trim()) renameWorkbench(editingId, editingName.trim());
    setEditingId(null);
  };

  const handleAdd = () => {
    const entry = addWorkbench();
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
  const ctxIsCore = ctxMenu ? BUILTIN_WORKBENCH_IDS.has(ctxMenu.wsId) : false;

  return (
    <>
    <div className="tb-center" ref={centerRef} role="tablist" aria-label="Workbenches" data-fx-slot="WorkbenchSwitcher" data-tour-id="tb-center">
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
            <IconForWorkbench id={ws.id} iconOverride={ws.icon} />
            {ws.name}
          </button>
        );
      })}
      <button className="ws-add-btn" title={t('workbenchSwitcher.addWorkbench')} onClick={handleAdd}>
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
            {t('workbenchSwitcher.rename')}
          </button>
        )}
        <button
          className="ws-ctx-item"
          onClick={() => {
            // P3.5 · Duplicate available for both built-ins (clone to a new
            // custom entry) and existing custom workbenches. Switches into the
            // fresh copy immediately so the user sees the new tab activate.
            const entry = duplicateWorkbench(ctxWs.id);
            if (entry) switchTo(entry.id);
            setCtxMenu(null);
          }}
        >
          {t('workbenchSwitcher.duplicate')}
        </button>
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
            onClick={() => { deleteWorkbench(ctxWs.id); setCtxMenu(null); }}
          >
            {t('workbenchSwitcher.deleteWorkbench')}
          </button>
        )}
      </FloatingMenu>
    )}
    </>
  );
}
