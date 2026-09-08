// material-preview-toolbar — the material / material-instance 3D preview's own
// header toolbar (primitive switcher · camera view · reset), lifted out of the
// canvas into the panel header via the GLOBAL panelActions/panelControls host
// capability.
//
// Ownership: this toolbar is INTERNAL to the material preview feature. Its state
// and behaviour never diffuse into a top-level contributions module — the store
// below is module-private (mirrors the viewport's own `useViewportPreferences`),
// and MaterialPreviewViewport self-registers a single `control` action against
// its own panel id through `useHost()`. Nothing above edit-runtime imports it;
// the header only decides WHERE the control renders, never WHAT it does.

import { useEffect, useSyncExternalStore, type ReactElement } from 'react';
import { useHost } from '@forgeax/interface/core/app-shell';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@forgeax/editor-ui/dropdown-menu';
import {
  Box,
  Camera,
  ChevronDown,
  Circle,
  RectangleHorizontal,
  Cylinder,
  Package,
  RotateCcw,
} from 'lucide-react';
import type { PreviewMeshKind } from './assemble-material-preview-world';
import type { CameraViewPreset } from './viewport-camera';
import './material-preview-toolbar.css';

// ── Module-private store (feature-internal; NOT lifted to any contributions) ──

export interface MaterialPreviewToolbarState {
  readonly meshKind: PreviewMeshKind;
  readonly cameraView: CameraViewPreset;
  readonly fovDegrees: number;
  readonly customMeshName: string | null;
}

export interface MaterialPreviewToolbarHandlers {
  readonly selectMeshKind: (kind: PreviewMeshKind) => void;
  readonly selectCameraView: (view: CameraViewPreset) => void;
  readonly setFov: (degrees: number) => void;
  readonly resetCamera: () => void;
}

const INITIAL: MaterialPreviewToolbarState = {
  meshKind: 'sphere',
  cameraView: 'perspective',
  fovDegrees: 60,
  customMeshName: null,
};

let state: MaterialPreviewToolbarState = INITIAL;
let handlers: MaterialPreviewToolbarHandlers | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export function setMaterialPreviewToolbarState(next: MaterialPreviewToolbarState): void {
  state = next;
  emit();
}

export function setMaterialPreviewToolbarHandlers(next: MaterialPreviewToolbarHandlers | null): void {
  handlers = next;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function useToolbarState(): MaterialPreviewToolbarState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

// ── View presets (parity with the previous in-canvas dropdown) ───────────────

const VIEW_PRESETS: readonly { id: CameraViewPreset; label: string; shortcut?: string }[] = [
  { id: 'perspective', label: 'Perspective', shortcut: 'Alt+G' },
  { id: 'top', label: 'Top', shortcut: 'Alt+J' },
  { id: 'bottom', label: 'Bottom' },
  { id: 'front', label: 'Front', shortcut: 'Alt+H' },
  { id: 'back', label: 'Back' },
  { id: 'left', label: 'Left', shortcut: 'Alt+K' },
  { id: 'right', label: 'Right' },
];

// Primitive buttons: icon-only (tooltip via title), lime active state from the
// shared `.fx-panel-action` header-button class.
const MESH_BUTTONS: readonly { kind: Exclude<PreviewMeshKind, 'custom'>; Icon: typeof Box; title: string }[] = [
  { kind: 'sphere', Icon: Circle, title: 'Sphere' },
  { kind: 'cube', Icon: Box, title: 'Cube' },
  { kind: 'plane', Icon: RectangleHorizontal, title: 'Plane' },
  { kind: 'cylinder', Icon: Cylinder, title: 'Cylinder' },
];

// ── The control (rendered inside PanelShell's header, reads the store) ────────

function MaterialPreviewToolbar(): ReactElement {
  const s = useToolbarState();
  const call = handlers;
  const activeViewLabel = VIEW_PRESETS.find((v) => v.id === s.cameraView)?.label ?? s.cameraView;
  const perspective = s.cameraView === 'perspective';

  return (
    <div className="fx-matpv-toolbar" role="toolbar" aria-label="Preview" data-testid="mi-preview-mesh-switcher">
      {MESH_BUTTONS.map(({ kind, Icon, title }) => (
        <button
          key={kind}
          type="button"
          className="fx-panel-action no-motion-lift"
          data-has-label="false"
          data-active={s.meshKind === kind ? 'true' : 'false'}
          data-testid={`mi-preview-mesh-${kind}`}
          title={title}
          aria-label={title}
          onClick={() => call?.selectMeshKind(kind)}
        >
          <Icon size={14} />
        </button>
      ))}
      <button
        type="button"
        className="fx-panel-action no-motion-lift"
        data-active={s.meshKind === 'custom' ? 'true' : 'false'}
        data-has-label={s.meshKind === 'custom' && s.customMeshName ? 'true' : 'false'}
        data-testid="mi-preview-mesh-custom"
        title={s.meshKind === 'custom' && s.customMeshName ? `Mesh: ${s.customMeshName}` : 'Pick custom Mesh asset'}
        aria-label="Custom mesh"
        onClick={() => call?.selectMeshKind('custom')}
      >
        <Package size={14} />
        {s.meshKind === 'custom' && s.customMeshName && (
          <span className="fx-panel-action-label" data-testid="mi-preview-current-mesh">{s.customMeshName}</span>
        )}
      </button>

      <span className="fx-matpv-sep" aria-hidden="true" />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="fx-panel-action no-motion-lift"
            data-has-label="true"
            data-testid="mi-camera-view-trigger"
            title="Camera View (Alt+G/J/H/K)"
            aria-label="Camera view"
          >
            <Camera size={14} />
            <span className="fx-panel-action-label" data-testid="mi-camera-view-label">{activeViewLabel}</span>
            <ChevronDown size={12} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[200px]">
          <DropdownMenuLabel>Camera Views</DropdownMenuLabel>
          {VIEW_PRESETS.map((v) => (
            <button
              key={v.id}
              type="button"
              className="fx-matpv-menu-item"
              data-active={s.cameraView === v.id ? 'true' : 'false'}
              data-testid={`mi-camera-view-${v.id}`}
              onClick={() => call?.selectCameraView(v.id)}
            >
              <span>{v.label}</span>
              {v.shortcut && <span className="fx-matpv-menu-shortcut">{v.shortcut}</span>}
            </button>
          ))}
          <DropdownMenuSeparator />
          <div className="fx-matpv-fov">
            <div className="fx-matpv-fov-head">
              <span>FOV</span>
              <span className="fx-matpv-fov-val">{s.fovDegrees}&deg;</span>
            </div>
            <input
              type="range"
              min={30}
              max={120}
              value={s.fovDegrees}
              disabled={!perspective}
              onChange={(e) => call?.setFov(Number(e.target.value))}
              data-testid="mi-camera-fov-slider"
            />
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <span className="fx-matpv-sep" aria-hidden="true" />

      <button
        type="button"
        className="fx-panel-action no-motion-lift"
        data-has-label="false"
        data-testid="mi-preview-reset-camera"
        title="Reset Camera (F)"
        aria-label="Reset camera"
        onClick={() => call?.resetCamera()}
      >
        <RotateCcw size={14} />
      </button>
    </div>
  );
}

// ── Self-registration hook (component owns its own header contribution) ───────

/**
 * Registers the material-preview toolbar as a single `control` panel action on
 * `panelId`'s header, for as long as the preview is mounted. `panelId` is null
 * when the active asset is neither a material nor a material instance, in which
 * case nothing is contributed.
 */
export function useMaterialPreviewToolbarRegistration(panelId: string | null): void {
  const host = useHost();
  useEffect(() => {
    if (!panelId) return;
    const controlId = `${panelId}.toolbar`;
    const offControls = host.panelControls.contribute(controlId, [
      { id: controlId, render: () => <MaterialPreviewToolbar /> },
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
