// mesh-preview-toolbar — the Mesh preview's own header toolbar (frame · reset ·
// bounds · skeleton · skeleton-tree toggles), lifted out of the canvas into the
// panel header via the GLOBAL panelActions/panelControls host capability.
//
// Ownership mirrors material-preview-toolbar: this toolbar is INTERNAL to the
// mesh preview feature. Its state and behaviour never diffuse into a top-level
// contributions module — the store below is module-private, and
// MeshPreviewViewport self-registers a single `control` action against its own
// panel id through `useHost()`. The header only decides WHERE the control
// renders, never WHAT it does.

import { useEffect, useSyncExternalStore, type ReactElement } from 'react';
import { useHost } from '@forgeax/interface/core/app-shell';
import { Bone, Box, Focus, ListTree, RotateCcw } from 'lucide-react';
import './mesh-preview-toolbar.css';

// ── Module-private store (feature-internal; NOT lifted to any contributions) ──

export interface MeshPreviewToolbarState {
  readonly ready: boolean;
  readonly boundsVisible: boolean;
  readonly skeletonVisible: boolean;
  readonly treeVisible: boolean;
  readonly hasSkeletonTree: boolean;
}

export interface MeshPreviewToolbarHandlers {
  readonly frameAll: () => void;
  readonly resetCamera: () => void;
  readonly toggleBounds: () => void;
  readonly toggleSkeleton: () => void;
  readonly toggleTree: () => void;
}

const INITIAL: MeshPreviewToolbarState = {
  ready: false,
  boundsVisible: true,
  skeletonVisible: true,
  treeVisible: true,
  hasSkeletonTree: false,
};

let state: MeshPreviewToolbarState = INITIAL;
let handlers: MeshPreviewToolbarHandlers | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export function setMeshPreviewToolbarState(next: MeshPreviewToolbarState): void {
  state = next;
  emit();
}

export function setMeshPreviewToolbarHandlers(next: MeshPreviewToolbarHandlers | null): void {
  handlers = next;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function useToolbarState(): MeshPreviewToolbarState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

// ── The control (rendered inside PanelShell's header, reads the store) ────────

function MeshPreviewToolbar(): ReactElement {
  const s = useToolbarState();
  const call = handlers;

  return (
    <div className="fx-meshpv-toolbar" role="toolbar" aria-label="Preview" data-testid="mesh-preview-toolbar">
      <button
        type="button"
        className="fx-panel-action no-motion-lift"
        data-has-label="false"
        data-testid="mesh-preview-frame"
        title="Frame All"
        aria-label="Frame all"
        disabled={!s.ready}
        onClick={() => call?.frameAll()}
      >
        <Focus size={14} />
      </button>
      <button
        type="button"
        className="fx-panel-action no-motion-lift"
        data-has-label="false"
        data-testid="mesh-preview-reset"
        title="Reset Camera"
        aria-label="Reset camera"
        onClick={() => call?.resetCamera()}
      >
        <RotateCcw size={14} />
      </button>

      <span className="fx-meshpv-sep" aria-hidden="true" />

      <button
        type="button"
        className="fx-panel-action no-motion-lift"
        data-has-label="false"
        data-active={s.boundsVisible ? 'true' : 'false'}
        data-testid="mesh-preview-bounds-toggle"
        aria-pressed={s.boundsVisible}
        title={s.boundsVisible ? 'Bounds: on' : 'Bounds: off'}
        aria-label="Toggle bounds overlay"
        disabled={!s.ready}
        onClick={() => call?.toggleBounds()}
      >
        <Box size={14} />
      </button>
      <button
        type="button"
        className="fx-panel-action no-motion-lift"
        data-has-label="false"
        data-active={s.skeletonVisible ? 'true' : 'false'}
        data-testid="mesh-preview-skeleton-toggle"
        aria-pressed={s.skeletonVisible}
        title={s.skeletonVisible ? 'Skeleton: on' : 'Skeleton: off'}
        aria-label="Toggle skeleton overlay"
        disabled={!s.ready}
        onClick={() => call?.toggleSkeleton()}
      >
        <Bone size={14} />
      </button>
      <button
        type="button"
        className="fx-panel-action no-motion-lift"
        data-has-label="false"
        data-active={s.treeVisible ? 'true' : 'false'}
        data-testid="mesh-preview-tree-toggle"
        aria-pressed={s.treeVisible}
        title={s.treeVisible ? 'Skeleton Tree: on' : 'Skeleton Tree: off'}
        aria-label="Toggle skeleton tree"
        disabled={!s.hasSkeletonTree}
        onClick={() => call?.toggleTree()}
      >
        <ListTree size={14} />
      </button>
    </div>
  );
}

// ── Self-registration hook (component owns its own header contribution) ───────

/**
 * Registers the mesh-preview toolbar as a single `control` panel action on
 * `panelId`'s header, for as long as the preview is mounted. `panelId` is null
 * when there is nothing to contribute (e.g. before the panel id is known).
 */
export function useMeshPreviewToolbarRegistration(panelId: string | null): void {
  const host = useHost();
  useEffect(() => {
    if (!panelId) return;
    const controlId = `${panelId}.toolbar`;
    const offControls = host.panelControls.contribute(controlId, [
      { id: controlId, render: () => <MeshPreviewToolbar /> },
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
