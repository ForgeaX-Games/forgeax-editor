import { useEffect, useRef } from 'react';
import { HierarchyPanel } from './panels/Hierarchy';
import { InspectorPanel } from './panels/Inspector';
import { deleteEntityCascade, deleteManyCascade } from './ops';
import {
  bus,
  getSelectionList,
  replaceDoc,
  requestRename,
  useDocVersion,
} from './store';
import type { SceneDocument } from './core/types';

// editor-runtime React shell: a fixed two-pane chrome (Hierarchy left, Inspector
// right) over the transparent center where the forgeax canvas shows through.
// Everything mutates through the command bus (undoable) — the same path the AI
// uses — so human edits and AI tool-calls are symmetric.
export function EditorApp() {
  useDocVersion(); // re-render toolbar enable/disable on every bus change
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

  function onSave() {
    const blob = new Blob([JSON.stringify(bus.doc, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'scene.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  function onLoadFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as SceneDocument;
        if (parsed && typeof parsed === 'object' && parsed.entities) replaceDoc(parsed);
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
        <button type="button" className="tbtn" data-testid="ed-undo" disabled={!bus.canUndo()} onClick={() => bus.undo()} title="Undo (⌘/Ctrl+Z)">↶ Undo</button>
        <button type="button" className="tbtn" data-testid="ed-redo" disabled={!bus.canRedo()} onClick={() => bus.redo()} title="Redo (⌘/Ctrl+Shift+Z)">↷ Redo</button>
        <button type="button" className="tbtn" data-testid="ed-save" onClick={onSave} title="Download the scene as JSON">⤓ Save</button>
        <button type="button" className="tbtn" data-testid="ed-load" onClick={() => fileRef.current?.click()} title="Load a scene JSON">⤒ Load</button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onLoadFile(f); e.currentTarget.value = ''; }}
        />
        <span className="ed-tool-sp" />
        <span className="ed-tool-hint">edit · same engine as ▶ play</span>
      </div>
      <div className="ed-left"><HierarchyPanel /></div>
      <div className="ed-center" />
      <div className="ed-right"><InspectorPanel /></div>
    </div>
  );
}
