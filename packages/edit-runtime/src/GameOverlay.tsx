// GameOverlay — minimal semi-transparent hover controls for display='game'
// (feat-20260630-viewport M5 / w24, requirements AC-13).
//
// display='game' hides the full ViewportBar and ViewportHints. The user needs a
// discoverable exit path — hover the viewport top edge to reveal a minimal
// semi-transparent overlay with only Play(▶)/Stop(■) + FPS readout. Touching
// nothing else, no gizmo mode, no save — just the two actions that transition out
// of the clean view. The overlay auto-hides when the cursor leaves the trigger zone.
//
// The overlay shows current run + display state via the quadrant SSOT read on
// every render. FPS is passed as a prop from the frame-loop accumulator so the
// overlay stays self-contained.

import { useState, useRef, useEffect, useCallback } from 'react';
import { getViewportQuadrant, onViewportQuadrantChange, type ViewportQuadrant } from './viewport/viewport-quadrant';

interface GameOverlayProps {
  fps: number;
  onPlay: () => void;
  onStop: () => void;
  onToggleDisplay: () => void;
  onControlGame: () => void;
}

export function GameOverlay({ fps, onPlay, onStop, onToggleDisplay, onControlGame }: GameOverlayProps) {
  const [visible, setVisible] = useState(false);
  const [quadrant, setQuadrant] = useState<ViewportQuadrant>(getViewportQuadrant);

  // Subscribe to quadrant changes so the overlay reflects live run state
  // (e.g. Play pressed → run='play' immediately shows ■ active).
  useEffect(() => {
    const unsub = onViewportQuadrantChange((q) => setQuadrant(q));
    return () => unsub();
  }, []);

  // Hover gate: the overlay appears only when the cursor enters the ~40px trigger
  // zone along the viewport top edge AND display is 'game'. It hides on mouse leave.
  const isPlay = quadrant.run === 'play';
  const gameControls = quadrant.control === 'game';

  return (
    <div
      className="vp-game-overlay-container"
      data-testid="game-overlay-container"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      {/* Invisible trigger zone — the overlay contents fade in only when hovered */}
      <div
        className={`vp-game-overlay ${visible ? 'vp-game-overlay--visible' : ''}`}
        data-testid="game-overlay"
      >
        <button
          type="button"
          className="vp-game-overlay-btn"
          data-testid="game-overlay-play"
          title={isPlay ? 'Stop (■)' : 'Play (▶)'}
          onClick={() => { if (isPlay) onStop(); else onPlay(); }}
        >
          {isPlay ? '■' : '▶'}
        </button>
        {isPlay && !gameControls && (
          <>
            <span className="vp-game-overlay-sep" />
            <button
              type="button"
              className="vp-game-overlay-btn"
              data-testid="game-overlay-control"
              title="Control game (click canvas also works)"
              onClick={onControlGame}
            >
              C
            </button>
          </>
        )}
        <span className="vp-game-overlay-sep" />
        <button
          type="button"
          className="vp-game-overlay-btn"
          data-testid="game-overlay-display"
          title="Toggle display (G)"
          onClick={onToggleDisplay}
        >
          G
        </button>
        <span className="vp-game-overlay-sep" />
        <span className="vp-game-overlay-fps" data-testid="game-overlay-fps">
          {fps} FPS
        </span>
      </div>
    </div>
  );
}
