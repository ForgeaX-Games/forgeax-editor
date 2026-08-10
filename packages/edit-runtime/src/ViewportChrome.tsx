// ViewportChrome — conditional wrapper for the editor chrome layer
// (feat-20260630-viewport M5 / w24, requirements AC-13).
//
// display='game': GameOverlay provides a minimal semi-transparent hover bar
//   with Play/Stop + FPS so the user has a discoverable exit path.
//
// The display mode is read from the quadrant SSOT via a subscription; the FPS
// value is passed through from the frame-loop accumulator held in main.tsx.

import { useState, useEffect } from 'react';
import { gateway, VISUAL_QUALITY_PRESETS, type VisualQualityPreset } from '@forgeax/editor-core';
import { getViewportQuadrant, onViewportQuadrantChange } from './viewport/viewport-quadrant';
import { GameOverlay } from './GameOverlay';
import { PlayTerminal } from './PlayTerminal';
import { ViewportViewMenu } from './ViewportViewMenu';

interface ViewportChromeProps {
  fps: number;
  onPlay: () => void;
  onStop: () => void;
  onToggleDisplay: () => void;
  onControlGame: () => void;
}

export function ViewportChrome({ fps, onPlay, onStop, onToggleDisplay, onControlGame }: ViewportChromeProps) {
  const [isGame, setIsGame] = useState<boolean>(() => getViewportQuadrant().display === 'game');
  const [qualityPreset, setQualityPreset] = useState<VisualQualityPreset>('balanced');

  useEffect(() => {
    const unsub = onViewportQuadrantChange((q) => {
      setIsGame(q.display === 'game');
    });
    return () => unsub();
  }, []);

  if (isGame) {
    return (
      <>
        <PlayTerminal onPlay={onPlay} onStop={onStop} />
        <GameOverlay
          fps={fps}
          onPlay={onPlay}
          onStop={onStop}
          onToggleDisplay={onToggleDisplay}
          onControlGame={onControlGame}
        />
      </>
    );
  }

  return (
    <>
      <PlayTerminal onPlay={onPlay} onStop={onStop} />
      <ViewportViewMenu />
      <div className="vp-quality-control" data-testid="vp-visual-quality-control">
        <label htmlFor="vp-visual-quality">Visual quality</label>
        <select
          id="vp-visual-quality"
          data-testid="vp-visual-quality"
          aria-label="Visual quality"
          value={qualityPreset}
          onChange={(event) => {
            const preset = event.target.value as VisualQualityPreset;
            setQualityPreset(preset);
            gateway.dispatch({ kind: 'applyVisualQualityPreset', preset }, 'human');
          }}
        >
          {VISUAL_QUALITY_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
        </select>
      </div>
    </>
  );
}
