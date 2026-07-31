// PlayTerminal — human projection of the Gateway-owned Play lifecycle.
//
// The Gateway is the only owner of playPhase and lastPlayError. This component
// keeps only a render signal (a primitive snapshot key) so the existing chrome
// can show the same terminal facts that a docs-only AI reads through Gateway.
// Human actions continue through the same play/stop dispatch callbacks.

import { useSyncExternalStore } from 'react';
import { gateway } from '@forgeax/editor-core';

type PlayPhase = 'edit' | 'starting' | 'play' | 'failed';

function getSnapshot(): string {
  const error = gateway.lastPlayError;
  return `${gateway.playPhase}|${error?.code ?? ''}|${error?.hint ?? ''}`;
}

function subscribe(listener: () => void): () => void {
  return gateway.subscribe(() => listener());
}

function parseSnapshot(snapshot: string): { phase: PlayPhase; code: string; hint: string } {
  const [phase, code = '', ...hintParts] = snapshot.split('|');
  const safePhase: PlayPhase = phase === 'starting' || phase === 'play' || phase === 'failed' ? phase : 'edit';
  return { phase: safePhase, code, hint: hintParts.join('|') };
}

export interface PlayTerminalProps {
  readonly onPlay: () => void;
  readonly onStop: () => void;
}

export function PlayTerminal({ onPlay, onStop }: PlayTerminalProps) {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { phase, code, hint } = parseSnapshot(snapshot);
  const label = phase === 'starting' ? 'Starting Play…'
    : phase === 'play' ? 'Playing'
      : phase === 'failed' ? 'Play failed'
        : 'Edit';

  return (
    <section
      className={`play-terminal play-terminal--${phase}`}
      data-testid="play-terminal"
      data-phase={phase}
      aria-label={`Play status: ${label}`}
    >
      <span className="play-terminal-indicator" aria-hidden="true" />
      <span className="play-terminal-label" data-testid="play-terminal-phase">{label}</span>
      {phase === 'failed' && (
        <span className="play-terminal-error" data-testid="play-terminal-error">
          {code}{hint ? `: ${hint}` : ''}
        </span>
      )}
      {phase === 'edit' && (
        <button type="button" className="play-terminal-action" data-testid="play-terminal-play" onClick={onPlay}>
          Play
        </button>
      )}
      {phase === 'starting' && (
        <button type="button" className="play-terminal-action" data-testid="play-terminal-starting" disabled>
          Starting…
        </button>
      )}
      {phase === 'play' && (
        <button type="button" className="play-terminal-action" data-testid="play-terminal-stop" onClick={onStop}>
          Stop
        </button>
      )}
      {phase === 'failed' && (
        <button type="button" className="play-terminal-action" data-testid="play-terminal-retry" onClick={onPlay}>
          Retry Play
        </button>
      )}
    </section>
  );
}
