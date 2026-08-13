import { forwardRef, useEffect, useReducer, useSyncExternalStore, type ButtonHTMLAttributes, type ReactNode } from 'react';
import {
  Axis3d,
  Box,
  Camera,
  ChevronDown,
  Crosshair,
  Eye,
  Globe,
  Magnet,
  MousePointer2,
  RotateCcw,
  SlidersHorizontal,
} from 'lucide-react';
import type { AppExtension, AppHost } from '@forgeax/interface/core/app-shell/types';
import { useHost } from '@forgeax/interface/core/app-shell';
import { APP_EVENTS } from '@forgeax/interface/lib/storageKeys';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@forgeax/editor-ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@forgeax/editor-ui/tooltip';
import {
  FLY_SPEED_MAX,
  FLY_SPEED_MIN,
  FOV_MAX,
  FOV_MIN,
  dispatchActiveEditorOperation,
  entComponents,
  gateway,
  getViewportRuntimeClientSnapshot,
  getGizmoMode,
  getGizmoSpace,
  getSceneFile,
  getSceneId,
  hasPendingDiskSave,
  onGizmoModeChange,
  onGizmoSpaceChange,
  onSceneListChange,
  queryViewportRuntimeProjection,
  subscribeViewportRuntimeClient,
  useDocVersion,
  useGizmoPivot,
  useGizmoSpace,
  useSceneFile,
  useSceneList,
  useSelection,
  useViewportPreferences,
  type ViewportPreferencesPatch,
} from '@forgeax/editor-core';
import { getLocale, useTranslation, type Locale } from '@forgeax/editor-core/i18n';
import {
  type DisplayMode,
  type RunMode,
} from './viewport-quadrant';
import { getFps, onFpsChange } from '../fps-store';
import './viewport-panel.css';

type ContextKeyValue = string | number | boolean;

function setContextKeys(host: AppHost, values: Record<string, ContextKeyValue>): void {
  for (const [key, value] of Object.entries(values)) host.contextKeys.set(key, value);
}

interface ViewportStatusProjection {
  readonly quadrant: {
    readonly run: RunMode;
    readonly display: DisplayMode;
    readonly control: 'editor' | 'game';
  };
  readonly fps: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

const DISCONNECTED_VIEWPORT_STATUS: ViewportStatusProjection = {
  quadrant: { run: 'edit', display: 'scene', control: 'editor' },
  fps: 0,
  canUndo: false,
  canRedo: false,
};
const viewportContextSignatures = new WeakMap<AppHost, string>();
let projectedFps = 0;
const projectedFpsListeners = new Set<() => void>();

function subscribeProjectedFps(listener: () => void): () => void {
  projectedFpsListeners.add(listener);
  return () => projectedFpsListeners.delete(listener);
}

function readProjectedFps(): number {
  return projectedFps;
}

function syncViewportContext(host: AppHost, status: ViewportStatusProjection, mounted: boolean): void {
  const q = status.quadrant;
  const signature = `${mounted}:${q.run}:${q.display}:${q.control}:${status.fps}:${status.canUndo}:${status.canRedo}`;
  if (projectedFps !== status.fps) {
    projectedFps = status.fps;
    for (const listener of projectedFpsListeners) listener();
  }
  if (viewportContextSignatures.get(host) === signature) return;
  viewportContextSignatures.set(host, signature);
  const running = q.run !== 'edit';
  document.documentElement.dataset.forgeaxViewportRunning = String(running);
  window.dispatchEvent(new CustomEvent(APP_EVENTS.viewportRunChanged, {
    detail: { running },
  }));
  setContextKeys(host, {
    'panel.viewport.mounted': mounted,
    'panel.viewport.run': q.run,
    'panel.viewport.display': q.display,
    'panel.viewport.isEdit': q.run === 'edit',
    'panel.viewport.isPlay': q.run === 'play',
    'panel.viewport.isRunning': q.run !== 'edit',
    'panel.viewport.isGame': q.display === 'game',
    'panel.viewport.isScene': q.display === 'scene',
    'panel.viewport.control': q.control,
    'panel.viewport.hasGameControl': q.control === 'game',
    'panel.viewport.canUndo': status.canUndo,
    'panel.viewport.canRedo': status.canRedo,
    'panel.viewport.fps': status.fps,
  });
}

async function refreshViewportContext(host: AppHost): Promise<void> {
  if (getViewportRuntimeClientSnapshot().status !== 'ready') {
    syncViewportContext(host, DISCONNECTED_VIEWPORT_STATUS, false);
    return;
  }
  try {
    const envelope = await queryViewportRuntimeProjection<ViewportStatusProjection>({ kind: 'viewport.status' });
    if (envelope.status === 'ready' && envelope.value !== null) {
      syncViewportContext(host, envelope.value, true);
      return;
    }
  } catch {
    // A carrier reload invalidates the cache; the next connected poll repopulates it.
  }
  syncViewportContext(host, DISCONNECTED_VIEWPORT_STATUS, false);
}

function syncEditorContext(host: AppHost): void {
  setContextKeys(host, {
    'panel.viewport.gizmo': getGizmoMode(),
    'panel.viewport.dirty': hasPendingDiskSave(),
    'panel.viewport.fps': getFps(),
    'panel.viewport.sceneId': getSceneFile() ?? getSceneId(),
    'panel.viewport.rhiCaptureAvailable': typeof (globalThis as {
      __forgeax?: { captureFrame?: unknown };
    }).__forgeax?.captureFrame === 'function',
  });
}

function executeViewportCommand(host: AppHost, command: string, args?: unknown): void {
  void host.commands.execute(command, args).catch((err: unknown) => {
    console.error(`[viewport-panel] command "${command}" failed`, err);
  });
}

function commandResult(): { status: 'completed' } {
  return { status: 'completed' };
}

interface LocalizedText {
  readonly zh: string;
  readonly en: string;
}

function L(zh: string, en: string): LocalizedText {
  return { zh, en };
}

/** Viewport-preference edits go through the one gateway door (session op) so
 *  the toolbar menu, the Settings dock panel and AI dispatch the SAME op. */
function patchViewportPreferences(patch: ViewportPreferencesPatch): void {
  gateway.dispatch({ kind: 'setViewportPreferences', patch }, 'human');
}

function pickText(text: LocalizedText, locale: Locale): string {
  return locale === 'zh' ? text.zh : text.en;
}

function currentText(text: LocalizedText): string {
  return pickText(text, getLocale());
}

const VIEW_PRESETS = [
  { id: 'game', key: '1', swatch: '#c2c8cf', name: L('游戏效果', 'Game Look'), desc: L('最终画面，隐藏辅助', 'Final frame, aids hidden'), active: true },
  { id: 'material', key: '2', swatch: '#b58f5e', name: L('材质检查', 'Material'), desc: L('只看基础色 ≈ Unlit', 'Base color only ≈ Unlit'), active: false },
  { id: 'structure', key: '3', swatch: '#61afef', name: L('结构检查', 'Structure'), desc: L('线框 ≈ Wireframe', 'Wireframe'), active: false },
  { id: 'lighting', key: '4', swatch: '#9a9a9a', name: L('光照检查', 'Lighting'), desc: L('只看明暗关系', 'Read the values only'), active: false },
  { id: 'perf', key: '5', swatch: '#e5484d', name: L('性能检查', 'Performance'), desc: L('开销热力图', 'Cost heatmap'), active: false },
] as const;

type LayoutIconName = 'laySingle' | 'layCols' | 'layRows' | 'layoutGrid' | 'layTri';
interface LayoutItem {
  readonly id: string;
  readonly icon: LayoutIconName;
  readonly name: LocalizedText;
  readonly cells: number;
  readonly active: boolean;
}

const ACTIVE_LAYOUT: LayoutItem = { id: 'single', icon: 'laySingle', name: L('单视口', 'Single'), cells: 1, active: true };
const LAYOUT_ITEMS: readonly LayoutItem[] = [
  ACTIVE_LAYOUT,
  { id: 'h2', icon: 'layCols', name: L('左右分屏', 'Side by side'), cells: 2, active: false },
  { id: 'v2', icon: 'layRows', name: L('上下分屏', 'Stacked'), cells: 2, active: false },
  { id: 'quad', icon: 'layoutGrid', name: L('四分屏', 'Quad'), cells: 4, active: false },
  { id: 'triL', icon: 'layTri', name: L('一大两小', '1 + 2'), cells: 3, active: false },
];

interface RhiCaptureResult {
  readonly runId: string;
  readonly tapePath: string;
  readonly reportPath: string;
}

let rhiCaptureInFlight = false;
let rhiCaptureCanceled = false;

function isRhiCaptureResult(value: unknown): value is RhiCaptureResult {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Record<string, unknown>;
  return typeof result.runId === 'string'
    && typeof result.tapePath === 'string'
    && typeof result.reportPath === 'string';
}

async function captureRhiFrame(host: AppHost): Promise<void> {
  if (rhiCaptureInFlight) {
    rhiCaptureCanceled = true;
    return;
  }
  rhiCaptureInFlight = true;
  rhiCaptureCanceled = false;
  host.contextKeys.set('panel.viewport.rhiCapturing', true);
  const capture = (globalThis as { __forgeax?: { captureFrame?: (frames: number) => Promise<unknown> } })
    .__forgeax?.captureFrame;
  try {
    if (!capture) throw new Error('RHI capture unavailable — start with bun fx start --rhi-debug');

    const result = await capture(1);
    if (!isRhiCaptureResult(result)) throw new Error('Capture did not return its artifact paths');
    if (rhiCaptureCanceled) return;

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
  } catch (err) {
    const message = err instanceof Error ? err.message : 'RHI capture failed';
    console.error('[viewport-panel] RHI capture failed', err);
    window.alert(message);
  } finally {
    rhiCaptureInFlight = false;
    rhiCaptureCanceled = false;
    host.contextKeys.set('panel.viewport.rhiCapturing', false);
  }
}

function setRunMode(mode: RunMode): void {
  if (mode === 'play') {
    void dispatchActiveEditorOperation({ kind: 'play', dirtyPolicy: 'last-saved' });
    return;
  }
  void dispatchActiveEditorOperation({ kind: 'stop' });
}

function setDisplay(display: DisplayMode): void {
  void dispatchActiveEditorOperation({ kind: 'setDisplay', display }, 'human');
}

function releaseGameToSceneView(): void {
  void dispatchActiveEditorOperation({ kind: 'setDisplay', display: 'scene' }, 'human');
}

function possessGameFromSceneView(): void {
  void dispatchActiveEditorOperation({ kind: 'setDisplay', display: 'game' }, 'human');
}

function openStandalonePreview(): void {
  const slug = getSceneId();
  const url = slug && slug !== 'default' ? `/preview/?game=${encodeURIComponent(slug)}` : '/preview/';
  window.open(url, '_blank', 'noopener');
}

function registerViewportCommands(host: AppHost): Array<() => void> {
  return [
    host.commands.register({
      id: 'viewport.run.edit',
      title: 'Viewport: Edit mode',
      execute: () => { setRunMode('edit'); return commandResult(); },
    }),
    host.commands.register({
      id: 'viewport.run.play',
      title: 'Viewport: Play mode',
      execute: () => { setRunMode('play'); return commandResult(); },
    }),
    host.commands.register({
      id: 'viewport.run.simulate',
      title: 'Viewport: Simulate mode',
      execute: () => commandResult(),
    }),
    host.commands.register({
      id: 'viewport.run.stop',
      title: 'Viewport: Stop play mode',
      execute: () => { setRunMode('edit'); return commandResult(); },
    }),
    host.commands.register({
      id: 'viewport.display.scene',
      title: 'Viewport: Scene display',
      execute: () => { setDisplay('scene'); return commandResult(); },
    }),
    host.commands.register({
      id: 'viewport.display.game',
      title: 'Viewport: Game display',
      execute: () => { setDisplay('game'); return commandResult(); },
    }),
    host.commands.register({
      id: 'viewport.control.grantGame',
      title: 'Viewport: Possess game controls',
      execute: () => { possessGameFromSceneView(); return commandResult(); },
    }),
    host.commands.register({
      id: 'viewport.control.releaseGame',
      title: 'Viewport: Eject player controller',
      execute: () => { releaseGameToSceneView(); return commandResult(); },
    }),
    host.commands.register({
      id: 'viewport.gizmo.select',
      title: 'Viewport: Select tool',
      execute: () => commandResult(),
    }),
    host.commands.register({
      id: 'viewport.gizmo.move',
      title: 'Viewport: Move tool',
      execute: () => { gateway.dispatch({ kind: 'setGizmoMode', mode: 'translate' }); return commandResult(); },
    }),
    host.commands.register({
      id: 'viewport.gizmo.rotate',
      title: 'Viewport: Rotate tool',
      execute: () => { gateway.dispatch({ kind: 'setGizmoMode', mode: 'rotate' }); return commandResult(); },
    }),
    host.commands.register({
      id: 'viewport.gizmo.scale',
      title: 'Viewport: Scale tool',
      execute: () => { gateway.dispatch({ kind: 'setGizmoMode', mode: 'scale' }); return commandResult(); },
    }),
    host.commands.register({
      id: 'viewport.undo',
      title: 'Viewport: Undo',
      execute: () => { gateway.undo(); return commandResult(); },
    }),
    host.commands.register({
      id: 'viewport.redo',
      title: 'Viewport: Redo',
      execute: () => { gateway.redo(); return commandResult(); },
    }),
    host.commands.register({
      id: 'viewport.rhi.capture',
      title: 'Viewport: Capture RHI frame',
      execute: async () => { await captureRhiFrame(host); return commandResult(); },
    }),
    host.commands.register({
      id: 'viewport.preview.openStandalone',
      title: 'Viewport: Open standalone preview',
      execute: () => { openStandalonePreview(); return commandResult(); },
    }),
  ];
}

function usePanelContext<T>(key: string, fallback: T): T {
  const host = useHost();
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useDocVersion();
  useEffect(() => {
    const cleanup = host.contextKeys.onChange(key, () => bump());
    return () => { cleanup(); };
  }, [host, key]);
  return host.contextKeys.get<T>(key) ?? fallback;
}

function ViewportTooltipContent({ title }: { title: string }): ReactNode {
  return (
    <TooltipContent side="bottom" align="center" sideOffset={7}>
      {title}
    </TooltipContent>
  );
}

interface MenuTriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  title: string;
  active?: boolean;
  running?: boolean;
  children: ReactNode;
}

const MenuTrigger = forwardRef<HTMLButtonElement, MenuTriggerProps>(function MenuTrigger({
  title,
  active = false,
  running = false,
  className,
  children,
  ...props
}, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={['fx-vp-menu-trigger no-motion-lift', className].filter(Boolean).join(' ')}
      aria-label={title}
      data-active={active ? 'true' : 'false'}
      data-running={running ? 'true' : 'false'}
      {...props}
    >
      {children}
      <ChevronDown size={12} className="fx-vp-caret" />
    </button>
  );
});

function ToolMenuTrigger({
  title,
  active = false,
  running = false,
  children,
}: {
  title: string;
  active?: boolean;
  running?: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <TooltipProvider delayDuration={350} skipDelayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <MenuTrigger title={title} active={active} running={running}>
              {children}
            </MenuTrigger>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <ViewportTooltipContent title={title} />
      </Tooltip>
    </TooltipProvider>
  );
}

function PopPanel({
  title,
  align = 'center',
  width,
  children,
}: {
  title: string;
  align?: 'start' | 'center' | 'end';
  width?: number;
  children: ReactNode;
}): ReactNode {
  return (
    <DropdownMenuContent
      className="fx-vp-pop"
      align={align}
      sideOffset={6}
      style={width ? { minWidth: width } : undefined}
    >
      <div className="fx-vp-pop-title">{title}</div>
      {children}
    </DropdownMenuContent>
  );
}

function PopItem({
  icon,
  label,
  desc,
  kbd,
  active = false,
  disabled = false,
  command,
  onClick,
  onClose,
}: {
  icon: ReactNode;
  label: string;
  desc?: string;
  kbd?: string;
  active?: boolean;
  disabled?: boolean;
  command?: string;
  onClick?: () => void;
  onClose?: () => void;
}): ReactNode {
  const host = useHost();
  return (
    <button
      type="button"
      className="fx-vp-pop-item"
      data-active={active ? 'true' : 'false'}
      disabled={disabled}
      aria-disabled={disabled ? 'true' : undefined}
      onClick={() => {
        if (disabled) return;
        if (onClick) { onClick(); onClose?.(); return; }
        if (!command) return;
        executeViewportCommand(host, command);
        onClose?.();
      }}
    >
      <span className="fx-vp-pop-icon">{icon}</span>
      <span className="fx-vp-pop-text">
        <span className="fx-vp-pop-label">{label}</span>
        {desc && <span className="fx-vp-pop-desc">{desc}</span>}
      </span>
      {kbd && <span className="fx-vp-pop-key">{kbd}</span>}
    </button>
  );
}

function PopToggle({
  label,
  checked = false,
  disabled = false,
  testId,
  onChange,
}: {
  label: string;
  checked?: boolean;
  disabled?: boolean;
  testId?: string;
  onChange?: (next: boolean) => void;
}): ReactNode {
  return (
    <button
      type="button"
      className="fx-vp-pop-toggle"
      data-testid={testId}
      data-checked={checked ? 'true' : 'false'}
      disabled={disabled}
      aria-disabled={disabled ? 'true' : undefined}
      onClick={disabled || !onChange ? undefined : () => onChange(!checked)}
    >
      <span className="fx-vp-pop-label">{label}</span>
      <span className="fx-vp-switch" aria-hidden="true" />
    </button>
  );
}

function PopRange({
  label,
  value,
  display,
  min = 0,
  max = 100,
  step = 1,
  disabled = false,
  onChange,
}: {
  label: string;
  value: number;
  /** Formatted value shown at the row end; defaults to the raw number. */
  display?: string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  onChange?: (next: number) => void;
}): ReactNode {
  return (
    <div className="fx-vp-pop-range" aria-disabled={disabled ? 'true' : undefined}>
      <span className="fx-vp-pop-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        readOnly={!onChange}
        onChange={onChange ? (e) => onChange(Number(e.target.value)) : undefined}
      />
      <span className="fx-vp-pop-value">{display ?? String(value)}</span>
    </div>
  );
}

function PopSeparator(): ReactNode {
  return <div className="fx-vp-pop-sep" />;
}

function LayoutIcon({ name, size = 15 }: { name: LayoutIconName; size?: number }): ReactNode {
  const paths: Record<LayoutIconName, ReactNode> = {
    layoutGrid: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M12 4v16M3 12h18" />
      </>
    ),
    laySingle: <rect x="3" y="4" width="18" height="16" rx="2" />,
    layCols: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M12 4v16" />
      </>
    ),
    layRows: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M3 12h18" />
      </>
    ),
    layTri: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M13 4v16M13 12h8" />
      </>
    ),
  };

  return (
    <svg
      className="fx-vp-layout-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

function StatusReadout({
  icon,
  label,
  value,
  title,
  testId,
  numeric,
}: {
  icon?: ReactNode;
  label?: string;
  value?: ReactNode;
  title?: string;
  testId?: string;
  /** Reserve a stable, tabular width for a short numeric value (e.g. FPS) so a
   *  changing digit count neither jitters the toolbar nor drifts from the label. */
  numeric?: boolean;
}): ReactNode {
  return (
    <span
      className={numeric ? 'fx-vp-status fx-vp-status--numeric' : 'fx-vp-status'}
      data-testid={testId}
      title={title}
    >
      {icon && <span className="fx-vp-status-icon">{icon}</span>}
      {label && <span className="fx-vp-status-label">{label}</span>}
      {value !== undefined && value !== null && value !== '' && (
        <span className="fx-vp-status-value">{value}</span>
      )}
    </span>
  );
}

function SceneStatusControl(): ReactNode {
  const { t } = useTranslation();
  const sceneId = useSceneFile() ?? getSceneId();
  const scenes = useSceneList();
  const scene = scenes.find((entry) => entry.id === sceneId);
  const sceneLabel = getSceneId() === 'default'
    ? null
    : (scene?.name ?? scene?.id ?? t('editor.sceneBadge.mainScene'));

  return (
    <div className="fx-viewport-panel-toolbar" data-zone="left">
      {sceneLabel && (
        <StatusReadout
          icon={<Box size={13} />}
          label={sceneLabel}
          title={t('editor.sceneBadge.title')}
          testId="vp-scene-badge"
        />
      )}
    </div>
  );
}

function FpsStatusControl(): ReactNode {
  const fps = useSyncExternalStore(subscribeProjectedFps, readProjectedFps, () => 0);

  return (
    <div className="fx-viewport-panel-toolbar" data-zone="right">
      <StatusReadout label="FPS" value={fps} testId="vp-fps" numeric />
    </div>
  );
}

function VfxReplayControl(): ReactNode {
  const { i18n } = useTranslation();
  const selection = useSelection();
  const enabled = selection !== null
    && 'ParticleEffectPlayer' in entComponents(gateway.activeWorld, selection);
  const title = pickText(L('从头预览所选 VFX', 'Replay selected VFX from tick zero'), i18n.language);

  return (
    <TooltipProvider delayDuration={350} skipDelayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="fx-vp-menu-trigger no-motion-lift"
            data-testid="vp-vfx-replay"
            aria-label={title}
            disabled={!enabled}
            onClick={() => {
              if (selection !== null) {
                gateway.dispatch({ kind: 'replayParticleEffect', entity: selection }, 'human');
              }
            }}
          >
            <RotateCcw size={15} />
            <span>VFX</span>
          </button>
        </TooltipTrigger>
        <ViewportTooltipContent title={title} />
      </Tooltip>
    </TooltipProvider>
  );
}

function CoordinateMenuControl(): ReactNode {
  const { i18n } = useTranslation();
  const locale = i18n.language;
  const space = useGizmoSpace();
  const pivot = useGizmoPivot();

  return (
    <DropdownMenu>
      <ToolMenuTrigger title={pickText(L('坐标系', 'Coordinate space'), locale)}>
        {space === 'local' ? <Box size={15} /> : <Globe size={15} />}
      </ToolMenuTrigger>
      <PopPanel title={pickText(L('坐标系', 'Coordinate space'), locale)} width={180}>
        <PopItem icon={<Globe size={14} />} label={pickText(L('世界', 'World'), locale)} active={space === 'world'} onClick={() => gateway.dispatch({ kind: 'setGizmoSpace', space: 'world' } as never)} />
        <PopItem icon={<Box size={14} />} label={pickText(L('本地', 'Local'), locale)} active={space === 'local'} onClick={() => gateway.dispatch({ kind: 'setGizmoSpace', space: 'local' } as never)} />
        <PopSeparator />
        <PopItem icon={<Crosshair size={14} />} label={pickText(L('多选中心点', 'Selection center'), locale)} active={pivot === 'center'} onClick={() => gateway.dispatch({ kind: 'setGizmoPivot', pivot: 'center' })} />
        <PopItem icon={<MousePointer2 size={14} />} label={pickText(L('最后选中物体', 'Last selected'), locale)} active={pivot === 'lastSelected'} onClick={() => gateway.dispatch({ kind: 'setGizmoPivot', pivot: 'lastSelected' })} />
      </PopPanel>
    </DropdownMenu>
  );
}

function SnapMenuControl(): ReactNode {
  const { i18n } = useTranslation();
  const locale = i18n.language;

  return (
    <DropdownMenu>
      <ToolMenuTrigger title={pickText(L('吸附', 'Snapping'), locale)}>
        <Magnet size={15} />
      </ToolMenuTrigger>
      <PopPanel title={pickText(L('吸附', 'Snapping'), locale)}>
        <PopToggle label={pickText(L('网格吸附', 'Grid snap'), locale)} disabled />
        <PopToggle label={pickText(L('旋转吸附', 'Rotation snap'), locale)} disabled />
        <PopToggle label={pickText(L('缩放吸附', 'Scale snap'), locale)} disabled />
        <PopToggle label={pickText(L('表面吸附', 'Surface snap'), locale)} disabled />
        <PopSeparator />
        <PopRange label={pickText(L('网格步长', 'Grid step'), locale)} value={10} display="10 cm" disabled />
        <PopRange label={pickText(L('角度步长', 'Angle step'), locale)} value={15} display="15°" disabled />
      </PopPanel>
    </DropdownMenu>
  );
}

function CameraMenuControl(): ReactNode {
  const { i18n } = useTranslation();
  const locale = i18n.language;
  const prefs = useViewportPreferences();
  const perspective = prefs.projection === 'perspective';

  return (
    <DropdownMenu>
      <ToolMenuTrigger title={perspective ? pickText(L('透视', 'Perspective'), locale) : pickText(L('正交', 'Orthographic'), locale)}>
        <Camera size={15} />
      </ToolMenuTrigger>
      <PopPanel title={pickText(L('相机 · 视角与镜头', 'Camera · view & lens'), locale)}>
        <PopItem
          icon={<Eye size={14} />}
          label={pickText(L('透视', 'Perspective'), locale)}
          desc={pickText(L('3D 人眼视角', '3D eye view'), locale)}
          active={perspective}
          onClick={() => gateway.dispatch({ kind: 'cameraSetProjection', projection: 'perspective' }, 'human')}
        />
        <PopItem
          icon={<Axis3d size={14} />}
          label={pickText(L('正交', 'Orthographic'), locale)}
          desc={pickText(L('平行投影 · 无透视形变', 'Parallel projection'), locale)}
          active={!perspective}
          onClick={() => gateway.dispatch({ kind: 'cameraSetProjection', projection: 'orthographic' }, 'human')}
        />
        <PopItem icon={<Axis3d size={14} />} label={pickText(L('顶视', 'Top'), locale)} desc={pickText(L('正交 · 从上往下', 'Ortho · top-down'), locale)} disabled />
        <PopItem icon={<Box size={14} />} label={pickText(L('前视', 'Front'), locale)} desc={pickText(L('正交 · 从前', 'Ortho · front'), locale)} disabled />
        <PopItem icon={<Box size={14} />} label={pickText(L('侧视', 'Side'), locale)} desc={pickText(L('正交 · 从侧', 'Ortho · side'), locale)} disabled />
        <PopSeparator />
        <PopRange
          label={pickText(L('视野 FOV', 'FOV'), locale)}
          value={prefs.fov}
          min={FOV_MIN}
          max={FOV_MAX}
          step={Math.PI / 180}
          display={`${Math.round(prefs.fov * 180 / Math.PI)}°`}
          disabled={!perspective}
          onChange={(fov) => patchViewportPreferences({ fov })}
        />
      </PopPanel>
    </DropdownMenu>
  );
}

function ViewMenuControl(): ReactNode {
  const { i18n } = useTranslation();
  const locale = i18n.language;
  const prefs = useViewportPreferences();
  const run = usePanelContext<RunMode>('panel.viewport.run', 'edit');

  return (
    <DropdownMenu>
      <ToolMenuTrigger title={`${pickText(L('视图预设 · ', 'View · '), locale)}${pickText(VIEW_PRESETS[0].name, locale)}`}>
        <span className="fx-vp-swatch" style={{ background: VIEW_PRESETS[0].swatch }} />
        <Eye size={15} />
      </ToolMenuTrigger>
      <PopPanel title={pickText(L('视图预设', 'View presets'), locale)} width={270} align="end">
        {VIEW_PRESETS.map((preset) => (
          <PopItem
            key={preset.id}
            icon={<span className="fx-vp-swatch" style={{ background: preset.swatch }} />}
            label={pickText(preset.name, locale)}
            desc={pickText(preset.desc, locale)}
            kbd={preset.key}
            active={preset.active}
            disabled
          />
        ))}
        <PopToggle
          testId="vp-grid-toggle"
          label={pickText(L('Grid', 'Grid'), locale)}
          checked={prefs.gridVisible}
          onChange={(gridVisible) => patchViewportPreferences({ gridVisible })}
        />
        <PopSeparator />
        {run === 'edit' && (
          <PopItem
            icon={<Eye size={14} />}
            label={pickText(L('纯净预览', 'Clean preview'), locale)}
            desc={pickText(L('隐藏辅助线等', 'Hide editor aids'), locale)}
            disabled
          />
        )}
      </PopPanel>
    </DropdownMenu>
  );
}

function LayoutMenuControl(): ReactNode {
  const { i18n } = useTranslation();
  const locale = i18n.language;

  return (
    <DropdownMenu>
      <ToolMenuTrigger title={`${pickText(L('窗口布局 · ', 'Layout · '), locale)}${pickText(ACTIVE_LAYOUT.name, locale)}`}>
        <LayoutIcon name={ACTIVE_LAYOUT.icon} size={15} />
      </ToolMenuTrigger>
      <PopPanel title={pickText(L('窗口布局 · 分屏', 'Window layout · split'), locale)} width={216} align="end">
        {LAYOUT_ITEMS.map((layout) => {
          return (
            <PopItem
              key={layout.id}
              icon={<LayoutIcon name={layout.icon} size={15} />}
              label={pickText(layout.name, locale)}
              desc={`${layout.cells}${locale === 'zh' ? ' 个视口' : ' viewport(s)'}`}
              active={layout.active}
              disabled
            />
          );
        })}
      </PopPanel>
    </DropdownMenu>
  );
}

function SettingsMenuControl(): ReactNode {
  const { i18n } = useTranslation();
  const locale = i18n.language;
  const prefs = useViewportPreferences();

  return (
    <DropdownMenu>
      <ToolMenuTrigger title={pickText(L('视口设置', 'Viewport settings'), locale)}>
        <SlidersHorizontal size={15} />
      </ToolMenuTrigger>
      <PopPanel title={pickText(L('视口设置', 'Viewport settings'), locale)} align="end">
        <PopRange
          label={pickText(L('鼠标灵敏度', 'Sensitivity'), locale)}
          value={prefs.mouseSensitivity}
          min={0.05}
          max={5}
          step={0.05}
          display={prefs.mouseSensitivity.toFixed(2)}
          onChange={(mouseSensitivity) => patchViewportPreferences({ mouseSensitivity })}
        />
        <PopRange
          label={pickText(L('滚轮速度', 'Scroll speed'), locale)}
          value={prefs.wheelSpeedScalar}
          min={0.1}
          max={4}
          step={0.1}
          display={prefs.wheelSpeedScalar.toFixed(1)}
          onChange={(wheelSpeedScalar) => patchViewportPreferences({ wheelSpeedScalar })}
        />
        <PopRange
          label={pickText(L('飞行速度', 'Fly speed'), locale)}
          value={prefs.flySpeed}
          min={FLY_SPEED_MIN}
          max={FLY_SPEED_MAX}
          step={0.5}
          display={prefs.flySpeed.toFixed(1)}
          onChange={(flySpeed) => patchViewportPreferences({ flySpeed })}
        />
        <PopRange
          label={pickText(L('加速倍率', 'Boost multiplier'), locale)}
          value={prefs.flyBoostMultiplier}
          min={1}
          max={8}
          step={0.5}
          display={`×${prefs.flyBoostMultiplier.toFixed(1)}`}
          onChange={(flyBoostMultiplier) => patchViewportPreferences({ flyBoostMultiplier })}
        />
        <PopSeparator />
        <PopToggle
          label={pickText(L('反转 Y 轴', 'Invert Y'), locale)}
          checked={prefs.invertY}
          onChange={(invertY) => patchViewportPreferences({ invertY })}
        />
        <PopToggle
          label={pickText(L('反转滚轮方向', 'Invert wheel'), locale)}
          checked={prefs.wheelDirection === -1}
          onChange={(inverted) => patchViewportPreferences({ wheelDirection: inverted ? -1 : 1 })}
        />
      </PopPanel>
    </DropdownMenu>
  );
}

function SeparatorControl(): ReactNode {
  return <span className="fx-vp-separator" aria-hidden="true" />;
}

export function createEditorPanelContributionsExtension(): AppExtension {
  return {
    id: 'editor.viewport-panel-contributions',
    version: '1.0.0',
    requires: ['commands', 'panelActions', 'panelControls', 'contextKeys'],
    setup(ctx) {
      const host = ctx.host;
      syncViewportContext(host, DISCONNECTED_VIEWPORT_STATUS, false);
      syncEditorContext(host);
      host.contextKeys.set('panel.viewport.rhiCapturing', false);

      const cleanups: Array<() => void> = [
        ...registerViewportCommands(host),
        ctx.contributePanelControls([
          { id: 'viewport.sceneStatus', render: () => <SceneStatusControl /> },
          { id: 'viewport.vfxReplay', render: () => <VfxReplayControl /> },
          { id: 'viewport.fpsStatus', render: () => <FpsStatusControl /> },
          { id: 'viewport.coordMenu', render: () => <CoordinateMenuControl /> },
          { id: 'viewport.snapMenu', render: () => <SnapMenuControl /> },
          { id: 'viewport.cameraMenu', render: () => <CameraMenuControl /> },
          { id: 'viewport.viewMenu', render: () => <ViewMenuControl /> },
          { id: 'viewport.layoutMenu', render: () => <LayoutMenuControl /> },
          { id: 'viewport.settingsMenu', render: () => <SettingsMenuControl /> },
          { id: 'viewport.separator', render: () => <SeparatorControl /> },
        ]),
        ctx.contributePanelActions([
          {
            kind: 'control',
            id: 'viewport.scene.status',
            panelId: 'viewport',
            control: 'viewport.sceneStatus',
            location: 'header/left',
            order: 10,
            enablement: 'panel.viewport.mounted',
          },
          {
            id: 'viewport.run.play.action',
            panelId: 'viewport',
            command: 'viewport.run.play',
            title: 'Play',
            icon: 'Play',
            testId: 'vp-play',
            location: 'header/left',
            order: 20,
            overflowPriority: 1000,
            when: 'panel.viewport.isEdit',
            enablement: 'panel.viewport.mounted',
          },
          {
            id: 'viewport.run.stop.action',
            panelId: 'viewport',
            command: 'viewport.run.stop',
            title: 'Stop',
            icon: 'Square',
            testId: 'vp-stop',
            location: 'header/left',
            order: 20,
            overflowPriority: 1000,
            when: 'panel.viewport.isPlay',
            enablement: 'panel.viewport.mounted',
            activeWhen: 'panel.viewport.isPlay',
          },
          {
            kind: 'control',
            id: 'viewport.vfx.replay.control',
            panelId: 'viewport',
            control: 'viewport.vfxReplay',
            location: 'header/left',
            order: 25,
            overflowPriority: 950,
            when: 'panel.viewport.isEdit',
            enablement: 'panel.viewport.mounted',
          },
          {
            id: 'viewport.control.releaseGame.action',
            panelId: 'viewport',
            command: 'viewport.control.releaseGame',
            title: 'Eject',
            icon: 'LogOut',
            location: 'header/left',
            order: 30,
            overflowPriority: 900,
            when: 'panel.viewport.isPlay && panel.viewport.isGame',
            enablement: 'panel.viewport.mounted',
          },
          {
            id: 'viewport.control.grantGame.action',
            panelId: 'viewport',
            command: 'viewport.control.grantGame',
            title: 'Possess',
            icon: 'Gamepad2',
            location: 'header/left',
            order: 30,
            overflowPriority: 900,
            when: 'panel.viewport.isPlay && panel.viewport.isScene',
            enablement: 'panel.viewport.mounted',
          },
          {
            id: 'viewport.gizmo.move.action',
            panelId: 'viewport',
            command: 'viewport.gizmo.move',
            title: currentText(L('移动', 'Move')),
            icon: 'Move',
            location: 'header/center',
            order: 10,
            overflowPriority: 900,
            when: 'panel.viewport.isScene',
            enablement: 'panel.viewport.mounted',
            activeWhen: 'panel.viewport.gizmo == translate',
          },
          {
            id: 'viewport.gizmo.rotate.action',
            panelId: 'viewport',
            command: 'viewport.gizmo.rotate',
            title: currentText(L('旋转', 'Rotate')),
            icon: 'RotateCcw',
            location: 'header/center',
            order: 20,
            overflowPriority: 900,
            when: 'panel.viewport.isScene',
            enablement: 'panel.viewport.mounted',
            activeWhen: 'panel.viewport.gizmo == rotate',
          },
          {
            id: 'viewport.gizmo.scale.action',
            panelId: 'viewport',
            command: 'viewport.gizmo.scale',
            title: currentText(L('缩放', 'Scale')),
            icon: 'Maximize2',
            location: 'header/center',
            order: 30,
            overflowPriority: 900,
            when: 'panel.viewport.isScene',
            enablement: 'panel.viewport.mounted',
            activeWhen: 'panel.viewport.gizmo == scale',
          },
          {
            kind: 'control',
            id: 'viewport.coord.menu',
            panelId: 'viewport',
            control: 'viewport.coordMenu',
            location: 'header/center',
            order: 40,
            when: 'panel.viewport.isScene',
            enablement: 'panel.viewport.mounted',
          },
          {
            kind: 'control',
            id: 'viewport.snap.menu',
            panelId: 'viewport',
            control: 'viewport.snapMenu',
            location: 'header/center',
            order: 50,
            when: 'panel.viewport.isScene',
            enablement: 'panel.viewport.mounted',
          },
          {
            kind: 'control',
            id: 'viewport.center.separator',
            panelId: 'viewport',
            control: 'viewport.separator',
            location: 'header/center',
            order: 60,
            when: 'panel.viewport.isScene',
            enablement: 'panel.viewport.mounted',
          },
          {
            kind: 'control',
            id: 'viewport.camera.menu',
            panelId: 'viewport',
            control: 'viewport.cameraMenu',
            location: 'header/center',
            order: 70,
            enablement: 'panel.viewport.mounted',
          },
          {
            kind: 'control',
            id: 'viewport.fps.status',
            panelId: 'viewport',
            control: 'viewport.fpsStatus',
            location: 'header/right',
            order: 5,
            enablement: 'panel.viewport.mounted',
          },
          {
            kind: 'control',
            id: 'viewport.view.menu',
            panelId: 'viewport',
            control: 'viewport.viewMenu',
            location: 'header/right',
            order: 10,
            enablement: 'panel.viewport.mounted',
          },
          {
            kind: 'control',
            id: 'viewport.right.separator',
            panelId: 'viewport',
            control: 'viewport.separator',
            location: 'header/right',
            order: 30,
            enablement: 'panel.viewport.mounted',
          },
          {
            kind: 'control',
            id: 'viewport.layout.menu',
            panelId: 'viewport',
            control: 'viewport.layoutMenu',
            location: 'header/right',
            order: 40,
            enablement: 'panel.viewport.mounted',
          },
          {
            kind: 'control',
            id: 'viewport.settings.menu',
            panelId: 'viewport',
            control: 'viewport.settingsMenu',
            location: 'header/right',
            order: 50,
            enablement: 'panel.viewport.mounted',
          },
          {
            id: 'viewport.undo.action',
            panelId: 'viewport',
            command: 'viewport.undo',
            title: currentText(L('撤销', 'Undo')),
            icon: 'Undo2',
            testId: 'vp-undo',
            location: 'header/right',
            order: 60,
            overflowPriority: 1000,
            when: 'panel.viewport.isEdit',
            enablement: 'panel.viewport.canUndo',
          },
          {
            id: 'viewport.redo.action',
            panelId: 'viewport',
            command: 'viewport.redo',
            title: currentText(L('重做', 'Redo')),
            icon: 'Redo2',
            testId: 'vp-redo',
            location: 'header/right',
            order: 70,
            overflowPriority: 1000,
            when: 'panel.viewport.isEdit',
            enablement: 'panel.viewport.canRedo',
          },
          {
            id: 'viewport.rhi.capture.action',
            panelId: 'viewport',
            command: 'viewport.rhi.capture',
            title: 'RHI',
            icon: 'Box',
            testId: 'vp-rhi-capture',
            location: 'header/right',
            order: 90,
            enablement: 'panel.viewport.mounted',
            activeWhen: 'panel.viewport.rhiCapturing',
          },
          {
            id: 'viewport.preview.openStandalone.action',
            panelId: 'viewport',
            command: 'viewport.preview.openStandalone',
            title: 'Play standalone',
            icon: 'Monitor',
            location: 'header/right',
            order: 100,
            enablement: 'panel.viewport.mounted',
          },
        ]),
        subscribeViewportRuntimeClient(() => { void refreshViewportContext(host); }),
        onGizmoModeChange(() => syncEditorContext(host)),
        onFpsChange(() => syncEditorContext(host)),
        onSceneListChange(() => syncEditorContext(host)),
        gateway.subscribe(() => {
          syncEditorContext(host);
        }),
      ];

      const dirtyTimer = window.setInterval(() => syncEditorContext(host), 500);
      cleanups.push(() => window.clearInterval(dirtyTimer));
      let viewportRefreshInFlight = false;
      const refreshProjectedViewport = (): void => {
        if (viewportRefreshInFlight) return;
        viewportRefreshInFlight = true;
        void refreshViewportContext(host).finally(() => { viewportRefreshInFlight = false; });
      };
      refreshProjectedViewport();
      const viewportTimer = window.setInterval(refreshProjectedViewport, 250);
      cleanups.push(() => window.clearInterval(viewportTimer));

      return () => {
        for (const cleanup of cleanups.slice().reverse()) cleanup();
      };
    },
  };
}

export const createViewportPanelContributionsExtension = createEditorPanelContributionsExtension;
