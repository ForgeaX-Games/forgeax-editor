import { useEffect, useRef } from 'react';
import { docToPack, packToDoc, isScenePack } from '@forgeax/editor-core';
import { DockManager } from './Dock';
import { SceneBadge } from './SceneBadge';
import { deleteEntityCascade, deleteManyCascade } from '@forgeax/editor-shared';
import {
  bus,
  getSelectionList,
  replaceDoc,
  requestRename,
  saveDocToDisk,
  setGizmoMode,
  useDocVersion,
  useGizmoMode,
} from '@forgeax/editor-shared';
import type { SceneDocument } from '@forgeax/editor-core';

// editor-runtime React shell: a fixed two-pane chrome (Hierarchy left, Inspector
// right) over the transparent center where the forgeax canvas shows through.
// Everything mutates through the command bus (undoable) — the same path the AI
// uses — so human edits and AI tool-calls are symmetric.
export function EditorApp() {
  useDocVersion(); // re-render toolbar enable/disable on every bus change
  const gizmoMode = useGizmoMode();
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Global shortcuts: Undo/Redo/Delete/Rename. Skipped while typing in a field
  // so the Inspector / rename inputs keep native editing behavior.
  useEffect(() => {
    function isTyping(t: EventTarget | null): boolean {
      const el = t as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    }
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) bus.redo();
        else bus.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        bus.redo();
        return;
      }
      if (isTyping(e.target)) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const sel = getSelectionList();
        if (sel.length > 1) { e.preventDefault(); deleteManyCascade(sel); }
        else if (sel.length === 1) { e.preventDefault(); deleteEntityCascade(sel[0]!); }
        return;
      }
      if (e.key === 'F2') {
        const sel = getSelectionList();
        if (sel.length) { e.preventDefault(); requestRename(sel[sel.length - 1]!); }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Save = persist the scene to the game's native scene.pack.json on disk. Edits
  // already autosave (debounced) + mirror to localStorage; this is an explicit
  // immediate flush. Falls back to downloading the native pack only when there's
  // no game bound (the `default`/unbound scene has no disk target).
  function onSave() {
    void saveDocToDisk().then((ok) => {
      if (ok) return;
      const blob = new Blob([JSON.stringify(docToPack(bus.doc), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'scene.pack.json';
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  function onLoadFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        if (isScenePack(parsed)) replaceDoc(packToDoc(parsed));
        else if (parsed && typeof parsed === 'object' && parsed.entities) replaceDoc(parsed as SceneDocument);
      } catch {
        /* malformed JSON — ignore */
      }
    };
    reader.readAsText(file);
  }

  return (
    <div className="ed-overlay" data-testid="editor-overlay">
      <div className="ed-toolbar">
        <span className="ed-brand">✎ forgeax editor</span>
        <SceneBadge />
        <button type="button" className="tbtn" data-testid="ed-undo" disabled={!bus.canUndo()} onClick={() => bus.undo()} title="Undo (⌘/Ctrl+Z)">↶ Undo</button>
        <button type="button" className="tbtn" data-testid="ed-redo" disabled={!bus.canRedo()} onClick={() => bus.redo()} title="Redo (⌘/Ctrl+Shift+Z)">↷ Redo</button>
        <span className="ed-tool-div" />
        <button type="button" className={`tbtn${gizmoMode === 'translate' ? ' on' : ''}`} data-testid="ed-gizmo-translate" onClick={() => setGizmoMode('translate')} title="移动 (W)">⤧ 移动</button>
        <button type="button" className={`tbtn${gizmoMode === 'rotate' ? ' on' : ''}`} data-testid="ed-gizmo-rotate" onClick={() => setGizmoMode('rotate')} title="旋转 (E)">⟳ 旋转</button>
        <button type="button" className={`tbtn${gizmoMode === 'scale' ? ' on' : ''}`} data-testid="ed-gizmo-scale" onClick={() => setGizmoMode('scale')} title="缩放 (R)">⤢ 缩放</button>
        <span className="ed-tool-div" />
        <button type="button" className="tbtn" data-testid="ed-save" onClick={onSave} title="Download the scene as JSON">⤓ Save</button>
        <button type="button" className="tbtn" data-testid="ed-load" onClick={() => fileRef.current?.click()} title="Load a scene JSON">⤒ Load</button>
        <button type="button" className="tbtn" data-testid="ed-reset-layout" onClick={() => window.dispatchEvent(new CustomEvent('forgeax:editor:dock-reset'))} title="重置面板停靠布局">⟲ 布局</button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onLoadFile(f); e.currentTarget.value = ''; }}
        />
        <span className="ed-tool-sp" />
        <span className="ed-tool-hint">W/E/R 移动·旋转·缩放 · F 聚焦选中 · 拖面板标题→停靠/浮动</span>
      </div>
      <DockManager />
    </div>
  );
}
