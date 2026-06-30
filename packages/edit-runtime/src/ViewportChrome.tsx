// ViewportChrome — conditional wrapper for the editor chrome layer
// (feat-20260630-viewport M5 / w24, requirements AC-13).
//
// display='scene': full ViewportBar + ViewportHints rendered (editor mode).
// display='game': both hidden; GameOverlay provides a minimal semi-transparent
//   hover bar with Play/Stop + FPS so the user has a discoverable exit path.
//
// The display mode is read from the quadrant SSOT via a subscription; the FPS
// value is passed through from the frame-loop accumulator held in main.tsx.

import { useState, useEffect } from 'react';
import { getViewportQuadrant, onViewportQuadrantChange } from '../engine/viewport-quadrant';
import { ViewportBar } from './ViewportBar';
import { ViewportHints } from './ViewportHints';
import { GameOverlay } from './GameOverlay';

interface ViewportChromeProps {
  fps: number;
  onPlay: () => void;
  onStop: () => void;
  onToggleDisplay: () => void;
}

export function ViewportChrome({ fps, onPlay, onStop, onToggleDisplay }: ViewportChromeProps) {
  const [isGame, setIsGame] = useState<boolean>(() => getViewportQuadrant().display === 'game');

  useEffect(() => {
    const unsub = onViewportQuadrantChange((q) => setIsGame(q.display === 'game'));
    return () => unsub();
  }, []);

  if (isGame) {
    return (
      <GameOverlay
        fps={fps}
        onPlay={onPlay}
        onStop={onStop}
        onToggleDisplay={onToggleDisplay}
      />
    );
  }

  return (
    <>
      <ViewportBar onPlay={onPlay} onStop={onStop} onToggleDisplay={onToggleDisplay} />
      <ViewportHints />
    </>
  );
}