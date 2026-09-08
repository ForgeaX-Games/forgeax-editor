// texture-preview-toolbar — UE Texture Editor controls lifted into the panel
// header via the global panelControls host capability (mirrors mesh/material).

import { useEffect, useMemo, useSyncExternalStore, type ReactElement } from 'react';
import { useHost } from '@forgeax/interface/core/app-shell';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@forgeax/editor-ui/dropdown-menu';
import { ChevronDown, Grid2x2, RotateCcw } from 'lucide-react';
import type {
  TexturePreviewChannel,
  TexturePreviewColorSpaceDisplay,
  TexturePreviewTiling,
  TexturePreviewViewState,
} from '../preview-world/texture-preview-view-state';
import './texture-preview-toolbar.css';

export interface TexturePreviewToolbarState extends TexturePreviewViewState {
  readonly ready: boolean;
  readonly mipCount: number;
}

export interface TexturePreviewToolbarHandlers {
  readonly setViewState: (patch: Partial<TexturePreviewViewState>) => void;
  readonly resetView: () => void;
}

const CHANNEL_OPTIONS: readonly { value: TexturePreviewChannel; label: string }[] = [
  { value: 'rgb', label: 'RGB' },
  { value: 'r', label: 'R' },
  { value: 'g', label: 'G' },
  { value: 'b', label: 'B' },
  { value: 'a', label: 'A' },
];

const SPACE_OPTIONS: readonly { value: TexturePreviewColorSpaceDisplay; label: string }[] = [
  { value: 'asset', label: 'Asset' },
  { value: 'srgb', label: 'sRGB' },
  { value: 'linear', label: 'Linear' },
];

const TILE_OPTIONS: readonly { value: TexturePreviewTiling; label: string }[] = [
  { value: 1, label: '1×1' },
  { value: 2, label: '2×2' },
  { value: 4, label: '4×4' },
];

const INITIAL: TexturePreviewToolbarState = {
  ready: false,
  channel: 'rgb',
  mipLevel: 0,
  colorSpaceDisplay: 'asset',
  tiling: 1,
  checkerboardVisible: true,
  mipCount: 1,
};

let state: TexturePreviewToolbarState = INITIAL;
let handlers: TexturePreviewToolbarHandlers | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export function setTexturePreviewToolbarState(next: TexturePreviewToolbarState): void {
  state = next;
  emit();
}

export function setTexturePreviewToolbarHandlers(next: TexturePreviewToolbarHandlers | null): void {
  handlers = next;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function useToolbarState(): TexturePreviewToolbarState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

interface TexturePreviewMenuProps<T extends string | number> {
  readonly label: string;
  readonly value: T;
  readonly options: readonly { value: T; label: string }[];
  readonly disabled?: boolean;
  readonly testId: string;
  readonly onSelect: (value: T) => void;
}

function TexturePreviewMenu<T extends string | number>({
  label,
  value,
  options,
  disabled = false,
  testId,
  onSelect,
}: TexturePreviewMenuProps<T>): ReactElement {
  const activeLabel = options.find((option) => option.value === value)?.label ?? String(value);

  return (
    <div className="fx-texpv-field">
      <span className="fx-texpv-label">{label}</span>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <button
            type="button"
            className="fx-panel-action no-motion-lift fx-texpv-menu-trigger"
            data-has-label="true"
            data-testid={`${testId}-trigger`}
            aria-label={label}
            disabled={disabled}
          >
            <span className="fx-panel-action-label">{activeLabel}</span>
            <ChevronDown size={12} aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="fx-texpv-menu-content">
          {options.map((option) => (
            <DropdownMenuItem
              key={String(option.value)}
              size="sm"
              className="fx-texpv-menu-item"
              data-active={value === option.value ? 'true' : 'false'}
              data-testid={`${testId}-${String(option.value)}`}
              onSelect={() => onSelect(option.value)}
            >
              {option.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function TexturePreviewToolbar(): ReactElement {
  const s = useToolbarState();
  const call = handlers;

  const patch = (partial: Partial<TexturePreviewViewState>): void => {
    call?.setViewState(partial);
  };

  const mipOptions = useMemo(
    () => Array.from({ length: s.mipCount }, (_, level) => ({ value: level, label: String(level) })),
    [s.mipCount],
  );

  return (
    <div className="fx-texpv-toolbar" role="toolbar" aria-label="Texture preview" data-testid="texture-preview-toolbar">
      <TexturePreviewMenu
        label="Channel"
        testId="texture-preview-channel"
        value={s.channel}
        options={CHANNEL_OPTIONS}
        disabled={!s.ready}
        onSelect={(channel) => patch({ channel })}
      />

      <TexturePreviewMenu
        label="Mip"
        testId="texture-preview-mip"
        value={s.mipLevel}
        options={mipOptions}
        disabled={!s.ready || s.mipCount <= 1}
        onSelect={(mipLevel) => patch({ mipLevel })}
      />

      <TexturePreviewMenu
        label="Space"
        testId="texture-preview-space"
        value={s.colorSpaceDisplay}
        options={SPACE_OPTIONS}
        disabled={!s.ready}
        onSelect={(colorSpaceDisplay) => patch({ colorSpaceDisplay })}
      />

      <TexturePreviewMenu
        label="Tile"
        testId="texture-preview-tile"
        value={s.tiling}
        options={TILE_OPTIONS}
        disabled={!s.ready}
        onSelect={(tiling) => patch({ tiling })}
      />

      <span className="fx-texpv-sep" aria-hidden="true" />

      <button
        type="button"
        className="fx-panel-action no-motion-lift"
        data-has-label="false"
        data-active={s.checkerboardVisible ? 'true' : 'false'}
        title="Toggle alpha checkerboard"
        aria-pressed={s.checkerboardVisible}
        disabled={!s.ready}
        onClick={() => patch({ checkerboardVisible: !s.checkerboardVisible })}
      >
        <Grid2x2 size={14} aria-hidden="true" />
      </button>

      <button
        type="button"
        className="fx-panel-action no-motion-lift"
        data-has-label="false"
        title="Reset view"
        disabled={!s.ready}
        onClick={() => call?.resetView()}
      >
        <RotateCcw size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

export function useTexturePreviewToolbarRegistration(panelId: string | null): void {
  const host = useHost();
  useEffect(() => {
    if (!panelId) return;
    const controlId = `${panelId}.toolbar`;
    const offControls = host.panelControls.contribute(controlId, [
      { id: controlId, render: () => <TexturePreviewToolbar /> },
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
