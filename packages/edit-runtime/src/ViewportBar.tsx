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
import { gateway, useDocVersion, useGizmoMode, useSceneAuthoringSession } from '@forgeax/editor-core';
import { SceneBadge } from './SceneBadge';
import { DirtyIndicator } from './components/dirty-indicator';
import { onFpsChange, getFps } from './fps-store';
import { getViewportQuadrant, onViewportQuadrantChange } from './viewport/viewport-quadrant';
import { createHumanSaveRequest } from './save-operation-projection';

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

function createCaptureRequestId(): string {
  return `capture-${crypto.randomUUID()}`;
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
  const authoringSession = useSceneAuthoringSession();
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
    setCaptureState('capturing');
    try {
      const requestId = createCaptureRequestId();
      const accepted = gateway.dispatch({ kind: 'captureFrame', frames: 1, requestId }, 'human');
      if (!accepted.ok) throw new Error(accepted.error.hint);
      const terminal = await gateway.waitOperationRun(requestId);
      if (!terminal.ok) throw new Error(terminal.error.hint);
      if (terminal.value.status !== 'succeeded') {
        throw new Error(terminal.value.error?.hint ?? 'RHI frame capture failed');
      }
      const result = terminal.value.result;
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

  return (
    <div className="vp-bar" data-testid="viewport-bar">
      <SceneBadge />
      {authoringSession.mode === 'imported-preview' && (
        <span data-testid="imported-preview-readonly">Imported Preview · Read-only</span>
      )}
      <span className="vp-sep" />
      {/* ── Run controls (w25): ▶ Play / ■ Stop ── */}
      {isPlay ? (
        <button type="button" className="vp-btn on" data-testid="vp-stop"
          onClick={onStop} title="Stop (■)">■</button>
      ) : (
        <button type="button" className="vp-btn" data-testid="vp-play"
          onClick={onPlay} title="Play (▶)">▶</button>
      )}
      <button type="button" className={`vp-btn${isGame ? ' on' : ''}`} data-testid="vp-display"
        onClick={onToggleDisplay} title={isGame ? 'Show scene view (G / Shift+G)' : 'Game view (G / Shift+G)'}>G</button>
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
      <button type="button" className="vp-btn" data-testid="vp-camera-projection"
        onClick={() => gateway.dispatch({ kind: 'cameraToggleProjection' }, 'human')}
        title="Toggle Perspective / Orthographic (V)">V</button>
      <button type="button" className="vp-btn" data-testid="vp-camera-fov-in"
        onClick={() => gateway.dispatch({ kind: 'cameraAdjustFov', delta: 1 }, 'human')}
        title="Zoom view in (Z)">Z</button>
      <button type="button" className="vp-btn" data-testid="vp-camera-fov-out"
        onClick={() => gateway.dispatch({ kind: 'cameraAdjustFov', delta: -1 }, 'human')}
        title="Zoom view out (C)">C</button>
      <span className="vp-sep" />
      <DirtyIndicator />
      <span className="vp-sep" />
      <button type="button" className="vp-btn" data-testid="vp-save"
        disabled={authoringSession.saveTarget === null}
        onClick={() => gateway.dispatch(createHumanSaveRequest(), 'human')}
        title={authoringSession.mode === 'imported-preview'
          ? 'Imported previews are read-only; source editing awaits Engine support.'
          : 'Save scene (⌘S)'}>
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
