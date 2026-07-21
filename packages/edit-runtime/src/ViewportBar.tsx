// ViewportBar — editor toolbar for the viewport tab (display='scene').
//
// In the flat outer-DockShell architecture the edit panel runs as a pure
// viewport (engine canvas + gizmo, no inner DockManager). All editor panels
// live in the outer dock as ep:* iframes. The EditorApp toolbar is skipped
// in this mode, so Undo/Redo and other controls are surfaced here instead.
//
// State:
//   - Reads the authoritative gateway directly (this is the MAIN iframe, not a popout).
//   - canUndo/canRedo toggle button enable/disable in real-time via useDocVersion.
//   - Gizmo mode reads/writes the store's gizmoMode (same as EditorApp does).
//   - Save calls saveDocToDisk; keyboard shortcuts are registered here too.
//   - ▶/■/display + FPS: viewport quadrant controls (w25, requirements AC-05/06/04)
//     received as props from ViewportChrome.
import { useEffect, useState } from 'react';
// M3 (AC-03): gizmo-mode (session op) and save (session op) go through the one
// gateway door — gateway.dispatch({ kind, … }) — not the direct setGizmoMode /
// saveDocToDisk setters. (onPlay/onStop are wired to the gateway in m3-w9.)
import { gateway, useDocVersion, useGizmoMode } from '@forgeax/editor-core';
import { SceneBadge } from './SceneBadge';
import { DirtyIndicator } from './components/dirty-indicator';
import { onFpsChange, getFps } from './fps-store';
import { getViewportQuadrant, onViewportQuadrantChange } from './viewport/viewport-quadrant';

interface ViewportBarProps {
  onPlay: () => void;
  onStop: () => void;
  onToggleDisplay: () => void;
  onFullscreen: () => void;
}

interface RhiCaptureResult {
  readonly runId: string;
  readonly tapePath: string;
  readonly reportPath: string;
}

function isRhiCaptureResult(value: unknown): value is RhiCaptureResult {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Record<string, unknown>;
  return typeof result.runId === 'string'
    && typeof result.tapePath === 'string'
    && typeof result.reportPath === 'string';
}

export function ViewportBar({ onPlay, onStop, onToggleDisplay, onFullscreen }: ViewportBarProps) {
  useDocVersion(); // re-render on every command so canUndo/canRedo is live
  const gizmoMode = useGizmoMode();
  const [fps, setFpsState] = useState<number>(() => getFps());
  const [isPlay, setIsPlay] = useState<boolean>(() => getViewportQuadrant().run === 'play');
  const [isGame, setIsGame] = useState<boolean>(() => getViewportQuadrant().display === 'game');
  const [captureState, setCaptureState] = useState<'idle' | 'capturing' | 'error'>('idle');

  useEffect(() => {
    const unsubFps = onFpsChange(setFpsState);
    const unsubQuad = onViewportQuadrantChange((q) => {
      setIsPlay(q.run === 'play');
      setIsGame(q.display === 'game');
    });
    return () => { unsubFps(); unsubQuad(); };
  }, []);

  async function captureRhiFrame(): Promise<void> {
    const capture = (globalThis as { __forgeax?: { captureFrame?: (frames: number) => Promise<unknown> } })
      .__forgeax?.captureFrame;
    if (!capture) {
      setCaptureState('error');
      return;
    }

    setCaptureState('capturing');
    try {
      const result = await capture(1);
      if (!isRhiCaptureResult(result)) throw new Error('Capture did not return its artifact paths');

      const artifact = (file: 'frame-0.tape.bin' | 'frame-0.report.json') => {
        const url = new URL('/__forgeax-debug/artifact', window.location.origin);
        url.searchParams.set('runId', result.runId);
        url.searchParams.set('file', file);
        return url.href;
      };
      const reviewer = new URL('http://localhost:15274/');
      reviewer.searchParams.set('tapeUrl', artifact('frame-0.tape.bin'));
      reviewer.searchParams.set('reportUrl', artifact('frame-0.report.json'));
      window.open(reviewer.href, '_blank', 'noopener');
      setCaptureState('idle');
    } catch {
      setCaptureState('error');
    }
  }

  // Keyboard shortcuts — same as EditorApp so muscle memory is identical.
  // Keep W/E/R for gizmo, Ctrl+Z/Y/S for undo/redo/save.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) {
        const k = e.key.toLowerCase();
        if (k === 'w') gateway.dispatch({ kind: 'setGizmoMode', mode: 'translate' });
        else if (k === 'e') gateway.dispatch({ kind: 'setGizmoMode', mode: 'rotate' });
        else if (k === 'r') gateway.dispatch({ kind: 'setGizmoMode', mode: 'scale' });
        return;
      }
      if (e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) gateway.redo(); else gateway.undo();
        return;
      }
      if (e.key.toLowerCase() === 'y') { e.preventDefault(); gateway.redo(); }
      if (e.key.toLowerCase() === 's') { e.preventDefault(); gateway.dispatch({ kind: 'saveDocToDisk' }); }
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
      {isPlay && (
        <button type="button" className={`vp-btn${isGame ? ' on' : ''}`} data-testid="vp-display"
          onClick={onToggleDisplay} title={isGame ? 'Show scene view (Shift+G)' : 'Game view (Shift+G)'}>G</button>
      )}
      <span className="vp-sep" />
      {/* ── FPS counter (w25): live from frame-loop accumulator ── */}
      <span className="vp-fps" data-testid="vp-fps">{fps} FPS</span>
      <span className="vp-sep" />
      <button type="button" className="vp-btn" data-testid="vp-undo"
        disabled={!gateway.canUndo()} onClick={() => gateway.undo()} title="Undo (⌘Z)">
        ↶
      </button>
      <button type="button" className="vp-btn" data-testid="vp-redo"
        disabled={!gateway.canRedo()} onClick={() => gateway.redo()} title="Redo (⌘⇧Z)">
        ↷
      </button>
      <span className="vp-sep" />
      <button type="button" className={`vp-btn${gizmoMode === 'translate' ? ' on' : ''}`}
        onClick={() => gateway.dispatch({ kind: 'setGizmoMode', mode: 'translate' })} title="Move (W)">⤧</button>
      <button type="button" className={`vp-btn${gizmoMode === 'rotate' ? ' on' : ''}`}
        onClick={() => gateway.dispatch({ kind: 'setGizmoMode', mode: 'rotate' })} title="Rotate (E)">⟳</button>
      <button type="button" className={`vp-btn${gizmoMode === 'scale' ? ' on' : ''}`}
        onClick={() => gateway.dispatch({ kind: 'setGizmoMode', mode: 'scale' })} title="Scale (R)">⤢</button>
      <span className="vp-sep" />
      <DirtyIndicator />
      <span className="vp-sep" />
      <button type="button" className="vp-btn" data-testid="vp-save"
        onClick={() => gateway.dispatch({ kind: 'saveDocToDisk' })} title="Save scene (⌘S)">
        ⤓
      </button>
      <span className="vp-sep" />
      <button type="button" className={`vp-btn${captureState === 'error' ? ' error' : ''}`}
        data-testid="vp-rhi-capture" disabled={captureState === 'capturing'} onClick={() => void captureRhiFrame()}
        title={captureState === 'error'
          ? 'RHI capture unavailable — start with bun fx start --rhi-debug'
          : captureState === 'capturing' ? 'Capturing RHI frame…' : 'Capture RHI frame and open reviewer'}>
        {captureState === 'capturing' ? '…' : '▣'}
      </button>
      <span className="vp-sep" />
      {/* Fullscreen play (w26, AC-14): standalone play-runtime in a new tab */}
      <button type="button" className="vp-btn" data-testid="vp-fullscreen"
        onClick={onFullscreen} title="Play standalone">◉</button>
    </div>
  );
}
