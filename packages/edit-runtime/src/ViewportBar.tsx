// ViewportBar — editor toolbar for the viewport tab (display='scene').
//
// In the flat outer-DockShell architecture the edit panel runs as a pure
// viewport (engine canvas + gizmo, no inner DockManager). All editor panels
// live in the outer dock as ep:* iframes. The EditorApp toolbar is skipped
// in this mode, so Undo/Redo and other controls are surfaced here instead.
//
// State:
//   - Reads the authoritative bus directly (this is the MAIN iframe, not a popout).
//   - canUndo/canRedo toggle button enable/disable in real-time via useDocVersion.
//   - Gizmo mode reads/writes the store's gizmoMode (same as EditorApp does).
//   - Save calls saveDocToDisk; keyboard shortcuts are registered here too.
//   - ▶/■/G + FPS: viewport quadrant controls (w25, requirements AC-05/06/04)
//     received as props from ViewportChrome.
import { useEffect, useState } from 'react';
import { bus, saveDocToDisk, useDocVersion, setGizmoMode, useGizmoMode } from '@forgeax/editor-shared';
import { SceneBadge } from './SceneBadge';
import { DirtyIndicator } from './components/dirty-indicator';
import { onFpsChange, getFps } from './fps-store';
import { getViewportQuadrant, onViewportQuadrantChange } from '../engine/viewport-quadrant';

interface ViewportBarProps {
  onPlay: () => void;
  onStop: () => void;
  onToggleDisplay: () => void;
  onFullscreen: () => void;
}

export function ViewportBar({ onPlay, onStop, onToggleDisplay, onFullscreen }: ViewportBarProps) {
  useDocVersion(); // re-render on every command so canUndo/canRedo is live
  const gizmoMode = useGizmoMode();
  const [fps, setFpsState] = useState<number>(() => getFps());
  const [isPlay, setIsPlay] = useState<boolean>(() => getViewportQuadrant().run === 'play');
  const [isGame, setIsGame] = useState<boolean>(() => getViewportQuadrant().display === 'game');

  useEffect(() => {
    const unsubFps = onFpsChange(setFpsState);
    const unsubQuad = onViewportQuadrantChange((q) => {
      setIsPlay(q.run === 'play');
      setIsGame(q.display === 'game');
    });
    return () => { unsubFps(); unsubQuad(); };
  }, []);

  // Keyboard shortcuts — same as EditorApp so muscle memory is identical.
  // Keep W/E/R for gizmo, Ctrl+Z/Y/S for undo/redo/save.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) {
        const k = e.key.toLowerCase();
        if (k === 'w') setGizmoMode('translate');
        else if (k === 'e') setGizmoMode('rotate');
        else if (k === 'r') setGizmoMode('scale');
        return;
      }
      if (e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) bus.redo(); else bus.undo();
        return;
      }
      if (e.key.toLowerCase() === 'y') { e.preventDefault(); bus.redo(); }
      if (e.key.toLowerCase() === 's') { e.preventDefault(); void saveDocToDisk(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="vp-bar" data-testid="viewport-bar">
      <SceneBadge />
      <span className="vp-sep" />
      {/* ── Run controls (w25): ▶ Play / ■ Stop ── */}
      {isPlay ? (
        <button type="button" className="vp-btn on" data-testid="vp-stop"
          onClick={onStop} title="Stop (■)">■</button>
      ) : (
        <button type="button" className="vp-btn" data-testid="vp-play"
          onClick={onPlay} title="Play (▶)">▶</button>
      )}
      {/* ── Display toggle (w25): G scene⇄game ── */}
      <button type="button" className={`vp-btn${isGame ? ' on' : ''}`} data-testid="vp-display"
        onClick={onToggleDisplay} title={isGame ? 'Show aids (G)' : 'Game view (G)'}>G</button>
      <span className="vp-sep" />
      {/* ── FPS counter (w25): live from frame-loop accumulator ── */}
      <span className="vp-fps" data-testid="vp-fps">{fps} FPS</span>
      <span className="vp-sep" />
      <button type="button" className="vp-btn" data-testid="vp-undo"
        disabled={!bus.canUndo()} onClick={() => bus.undo()} title="Undo (⌘Z)">
        ↶
      </button>
      <button type="button" className="vp-btn" data-testid="vp-redo"
        disabled={!bus.canRedo()} onClick={() => bus.redo()} title="Redo (⌘⇧Z)">
        ↷
      </button>
      <span className="vp-sep" />
      <button type="button" className={`vp-btn${gizmoMode === 'translate' ? ' on' : ''}`}
        onClick={() => setGizmoMode('translate')} title="Move (W)">⤧</button>
      <button type="button" className={`vp-btn${gizmoMode === 'rotate' ? ' on' : ''}`}
        onClick={() => setGizmoMode('rotate')} title="Rotate (E)">⟳</button>
      <button type="button" className={`vp-btn${gizmoMode === 'scale' ? ' on' : ''}`}
        onClick={() => setGizmoMode('scale')} title="Scale (R)">⤢</button>
      <span className="vp-sep" />
      <DirtyIndicator />
      <span className="vp-sep" />
      <button type="button" className="vp-btn" data-testid="vp-save"
        onClick={() => void saveDocToDisk()} title="Save scene (⌘S)">
        ⤓
      </button>
      <span className="vp-sep" />
      {/* Fullscreen play (w26, AC-14): standalone play-runtime in a new tab */}
      <button type="button" className="vp-btn" data-testid="vp-fullscreen"
        onClick={onFullscreen} title="Play standalone">◉</button>
    </div>
  );
}