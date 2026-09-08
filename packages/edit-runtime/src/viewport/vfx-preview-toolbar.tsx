// vfx-preview-toolbar — the VFX preview's own header toolbar (play/pause · reset ·
// frame · bounds · phase scrub · live inspect), lifted out of the canvas into the
// panel header via the GLOBAL panelActions/panelControls host capability. Emitter
// visibility is NOT here: it lives as per-emitter eye toggles in the System
// Outline tree (panels/vfx-emitter-mask), which this preview subscribes to.
//
// Ownership mirrors mesh-preview-toolbar: this toolbar is INTERNAL to the VFX
// preview feature. Its state and behaviour never diffuse into a top-level
// contributions module — the store below is module-private, and
// VfxPreviewViewport self-registers a single `control` action against its own
// panel id through `useHost()`. The header only decides WHERE the control
// renders; every button still dispatches through the Runtime-owned transient
// operations owned by VfxPreviewViewport.

import { useEffect, useSyncExternalStore, type ReactElement } from 'react';
import { useHost } from '@forgeax/interface/core/app-shell';
import { Box, Focus, Pause, Play, RotateCcw } from 'lucide-react';
import './vfx-preview-toolbar.css';

// ── Module-private store (feature-internal; NOT lifted to any contributions) ──

export interface VfxPreviewToolbarState {
  readonly ready: boolean;
  readonly playing: boolean;
  readonly seeking: boolean;
  readonly leaseConnected: boolean;
  readonly boundsVisible: boolean;
  readonly phaseDraft: number;
  readonly maxPhaseTick: number;
  readonly inspectText: string;
}

export interface VfxPreviewToolbarHandlers {
  readonly togglePlay: () => void;
  readonly reset: () => void;
  readonly frameBounds: () => void;
  readonly toggleBounds: () => void;
  readonly setPhaseDraft: (next: number) => void;
  readonly seek: (next: number) => void;
}

const INITIAL: VfxPreviewToolbarState = {
  ready: false,
  playing: true,
  seeking: false,
  leaseConnected: false,
  boundsVisible: false,
  phaseDraft: 0,
  maxPhaseTick: 300,
  inspectText: '',
};

let state: VfxPreviewToolbarState = INITIAL;
let handlers: VfxPreviewToolbarHandlers | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export function setVfxPreviewToolbarState(next: VfxPreviewToolbarState): void {
  state = next;
  emit();
}

export function setVfxPreviewToolbarHandlers(next: VfxPreviewToolbarHandlers | null): void {
  handlers = next;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function useToolbarState(): VfxPreviewToolbarState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

// ── The control (rendered inside PanelShell's header, reads the store) ────────

function VfxPreviewToolbar(): ReactElement {
  const s = useToolbarState();
  const call = handlers;
  const actionable = s.ready && !s.seeking && s.leaseConnected;

  return (
    <div className="fx-vfxpv-toolbar" role="toolbar" aria-label="Preview" data-testid="vfx-preview-toolbar">
      <button
        type="button"
        className="fx-panel-action no-motion-lift"
        data-has-label="false"
        data-testid="vfx-preview-play"
        title={s.playing ? 'Pause' : 'Play'}
        aria-label={s.playing ? 'Pause preview' : 'Play preview'}
        disabled={!actionable}
        onClick={() => call?.togglePlay()}
      >
        {s.playing ? <Pause size={14} /> : <Play size={14} />}
      </button>
      <button
        type="button"
        className="fx-panel-action no-motion-lift"
        data-has-label="false"
        data-testid="vfx-preview-reset"
        title="Reset"
        aria-label="Reset preview"
        disabled={!actionable}
        onClick={() => call?.reset()}
      >
        <RotateCcw size={14} />
      </button>
      <button
        type="button"
        className="fx-panel-action no-motion-lift"
        data-has-label="false"
        data-testid="vfx-preview-frame"
        title="Frame Bounds"
        aria-label="Frame preview bounds"
        disabled={!actionable}
        onClick={() => call?.frameBounds()}
      >
        <Focus size={14} />
      </button>
      <button
        type="button"
        className="fx-panel-action no-motion-lift"
        data-has-label="false"
        data-active={s.boundsVisible ? 'true' : 'false'}
        data-testid="vfx-preview-bounds-toggle"
        aria-pressed={s.boundsVisible}
        title={s.boundsVisible ? 'Bounds: on' : 'Bounds: off'}
        aria-label="Toggle bounds overlay"
        disabled={!actionable}
        onClick={() => call?.toggleBounds()}
      >
        <Box size={14} />
      </button>

      <span className="fx-vfxpv-sep" aria-hidden="true" />

      <label className="fx-vfxpv-phase" title="Scrub emitter phase">
        <span>Phase</span>
        <input
          type="range"
          min={0}
          max={s.maxPhaseTick}
          step={1}
          value={Math.min(s.maxPhaseTick, s.phaseDraft)}
          disabled={!actionable}
          onChange={(event) => call?.setPhaseDraft(Number(event.currentTarget.value))}
          onPointerUp={(event) => call?.seek(Number(event.currentTarget.value))}
          onKeyUp={(event) => call?.seek(Number(event.currentTarget.value))}
        />
        <output>{s.phaseDraft}</output>
      </label>

      {s.inspectText && <span className="fx-vfxpv-inspect">{s.inspectText}</span>}
    </div>
  );
}

// ── Self-registration hook (component owns its own header contribution) ───────

/**
 * Registers the VFX preview toolbar as a single `control` panel action on
 * `panelId`'s header, for as long as the preview is mounted.
 */
export function useVfxPreviewToolbarRegistration(panelId: string | null): void {
  const host = useHost();
  useEffect(() => {
    if (!panelId) return;
    const controlId = `${panelId}.toolbar`;
    const offControls = host.panelControls.contribute(controlId, [
      { id: controlId, render: () => <VfxPreviewToolbar /> },
    ]);
    const offActions = host.panelActions.contribute(controlId, [
      {
        kind: 'control',
        id: `${controlId}.action`,
        panelId,
        control: controlId,
        location: 'header/left',
        order: 10,
      },
    ]);
    return () => { offControls(); offActions(); };
  }, [host, panelId]);
}
