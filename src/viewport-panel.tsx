import { forwardRef, useEffect, useReducer, type ButtonHTMLAttributes, type ReactNode } from 'react';
import {
  Axis3d,
  Box,
  Camera,
  ChevronDown,
  Eye,
  Globe,
  Magnet,
  RotateCcw,
  SlidersHorizontal,
} from 'lucide-react';
import type { AppExtension, AppHost } from '@forgeax/interface/core/app-shell/types';
import { useHost } from '@forgeax/interface/core/app-shell';
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
  gateway,
  getGizmoMode,
  getGizmoSpace,
  getSceneFile,
  getSceneId,
  hasPendingDiskSave,
  onGizmoModeChange,
  onGizmoSpaceChange,
  onSceneListChange,
  useDocVersion,
  useGizmoSpace,
  useSceneFile,
  useSceneList,
} from '@forgeax/editor-core';
import { getLocale, useTranslation, type Locale } from '@forgeax/editor-core/i18n';
import {
  getViewportQuadrant,
  onViewportQuadrantChange,
  type DisplayMode,
  type RunMode,
} from '@forgeax/editor-edit-runtime/viewport/quadrant';
import { getFps, onFpsChange } from '@forgeax/editor-edit-runtime/fps';
import './viewport-panel.css';

type ContextKeyValue = string | number | boolean;

function setContextKeys(host: AppHost, values: Record<string, ContextKeyValue>): void {
  for (const [key, value] of Object.entries(values)) host.contextKeys.set(key, value);
}

function syncViewportContext(host: AppHost): void {
  const q = getViewportQuadrant();
  setContextKeys(host, {
    'panel.viewport.mounted': true,
    'panel.viewport.run': q.run,
    'panel.viewport.display': q.display,
    'panel.viewport.isEdit': q.run === 'edit',
    'panel.viewport.isPlay': q.run === 'play',
    'panel.viewport.isRunning': q.run !== 'edit',
    'panel.viewport.isGame': q.display === 'game',
    'panel.viewport.isScene': q.display === 'scene',
    'panel.viewport.control': q.control,
    'panel.viewport.hasGameControl': q.control === 'game',
  });
}

function syncEditorContext(host: AppHost): void {
  setContextKeys(host, {
    'panel.viewport.gizmo': getGizmoMode(),
    'panel.viewport.canUndo': gateway.canUndo(),
    'panel.viewport.canRedo': gateway.canRedo(),
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
    gateway.dispatch({ kind: 'play' });
    return;
  }
  gateway.dispatch({ kind: 'stop' });
}

function setDisplay(display: DisplayMode): void {
  gateway.dispatch({ kind: 'setDisplay', display }, 'human');
}

function releaseGameToSceneView(): void {
  gateway.dispatch({ kind: 'setDisplay', display: 'scene' }, 'human');
}

function possessGameFromSceneView(): void {
  gateway.dispatch({ kind: 'setDisplay', display: 'game' }, 'human');
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
      id: 'viewport.save',
      title: 'Viewport: Save scene',
      execute: () => { gateway.dispatch({ kind: 'saveDocToDisk' }); return commandResult(); },
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
  disabled = true,
}: {
  label: string;
  checked?: boolean;
  disabled?: boolean;
}): ReactNode {
  return (
    <button
      type="button"
      className="fx-vp-pop-toggle"
      data-checked={checked ? 'true' : 'false'}
      disabled={disabled}
      aria-disabled={disabled ? 'true' : undefined}
    >
      <span className="fx-vp-pop-label">{label}</span>
      <span className="fx-vp-switch" aria-hidden="true" />
    </button>
  );
}

function PopRange({
  label,
  value,
}: {
  label: string;
  value: string;
}): ReactNode {
  return (
    <div className="fx-vp-pop-range" aria-disabled="true">
      <span className="fx-vp-pop-label">{label}</span>
      <input type="range" min={0} max={100} value={60} disabled readOnly />
      <span className="fx-vp-pop-value">{value}</span>
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
}: {
  icon?: ReactNode;
  label?: string;
  value?: ReactNode;
  title?: string;
  testId?: string;
}): ReactNode {
  return (
    <span className="fx-vp-status" data-testid={testId} title={title}>
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
  const fps = usePanelContext<number>('panel.viewport.fps', 0);

  return (
    <div className="fx-viewport-panel-toolbar" data-zone="right">
      <StatusReadout label="FPS" value={fps} testId="vp-fps" />
    </div>
  );
}

function CoordinateMenuControl(): ReactNode {
  const { i18n } = useTranslation();
  const locale = i18n.language;
  const space = useGizmoSpace();

  return (
    <DropdownMenu>
      <ToolMenuTrigger title={pickText(L('坐标系', 'Coordinate space'), locale)}>
        {space === 'local' ? <Box size={15} /> : <Globe size={15} />}
      </ToolMenuTrigger>
      <PopPanel title={pickText(L('坐标系', 'Coordinate space'), locale)} width={180}>
        <PopItem icon={<Globe size={14} />} label={pickText(L('世界', 'World'), locale)} active={space === 'world'} onClick={() => gateway.dispatch({ kind: 'setGizmoSpace', space: 'world' } as never)} />
        <PopItem icon={<Box size={14} />} label={pickText(L('本地', 'Local'), locale)} active={space === 'local'} onClick={() => gateway.dispatch({ kind: 'setGizmoSpace', space: 'local' } as never)} />
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
        <PopToggle label={pickText(L('网格吸附', 'Grid snap'), locale)} />
        <PopToggle label={pickText(L('旋转吸附', 'Rotation snap'), locale)} />
        <PopToggle label={pickText(L('缩放吸附', 'Scale snap'), locale)} />
        <PopToggle label={pickText(L('表面吸附', 'Surface snap'), locale)} />
        <PopSeparator />
        <PopRange label={pickText(L('网格步长', 'Grid step'), locale)} value="10 cm" />
        <PopRange label={pickText(L('角度步长', 'Angle step'), locale)} value="15°" />
      </PopPanel>
    </DropdownMenu>
  );
}

function CameraMenuControl(): ReactNode {
  const { i18n } = useTranslation();
  const locale = i18n.language;

  return (
    <DropdownMenu>
      <ToolMenuTrigger title={pickText(L('透视', 'Perspective'), locale)}>
        <Camera size={15} />
      </ToolMenuTrigger>
      <PopPanel title={pickText(L('相机 · 视角与镜头', 'Camera · view & lens'), locale)}>
        <PopItem icon={<Eye size={14} />} label={pickText(L('透视', 'Perspective'), locale)} desc={pickText(L('3D 人眼视角', '3D eye view'), locale)} active disabled />
        <PopItem icon={<Axis3d size={14} />} label={pickText(L('顶视', 'Top'), locale)} desc={pickText(L('正交 · 从上往下', 'Ortho · top-down'), locale)} disabled />
        <PopItem icon={<Box size={14} />} label={pickText(L('前视', 'Front'), locale)} desc={pickText(L('正交 · 从前', 'Ortho · front'), locale)} disabled />
        <PopItem icon={<Box size={14} />} label={pickText(L('侧视', 'Side'), locale)} desc={pickText(L('正交 · 从侧', 'Ortho · side'), locale)} disabled />
        <PopSeparator />
        <PopRange label={pickText(L('视野 FOV', 'FOV'), locale)} value="90°" />
        <PopRange label={pickText(L('相机速度', 'Speed'), locale)} value="4" />
      </PopPanel>
    </DropdownMenu>
  );
}

function ViewMenuControl(): ReactNode {
  const { i18n } = useTranslation();
  const locale = i18n.language;
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

  return (
    <DropdownMenu>
      <ToolMenuTrigger title={pickText(L('视口设置', 'Viewport settings'), locale)}>
        <SlidersHorizontal size={15} />
      </ToolMenuTrigger>
      <PopPanel title={pickText(L('视口设置', 'Viewport settings'), locale)} align="end">
        <PopRange label={pickText(L('鼠标灵敏度', 'Sensitivity'), locale)} value="5" />
        <PopRange label={pickText(L('滚轮速度', 'Scroll'), locale)} value="6" />
        <PopRange label={pickText(L('音量', 'Volume'), locale)} value="70%" />
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
      syncViewportContext(host);
      syncEditorContext(host);
      host.contextKeys.set('panel.viewport.rhiCapturing', false);

      const cleanups: Array<() => void> = [
        ...registerViewportCommands(host),
        ctx.contributePanelControls([
          { id: 'viewport.sceneStatus', render: () => <SceneStatusControl /> },
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
            when: 'panel.viewport.isPlay',
            enablement: 'panel.viewport.mounted',
            activeWhen: 'panel.viewport.isPlay',
          },
          {
            id: 'viewport.control.releaseGame.action',
            panelId: 'viewport',
            command: 'viewport.control.releaseGame',
            title: 'Eject',
            icon: 'LogOut',
            location: 'header/left',
            order: 30,
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
            enablement: 'panel.viewport.mounted',
          },
          {
            kind: 'control',
            id: 'viewport.snap.menu',
            panelId: 'viewport',
            control: 'viewport.snapMenu',
            location: 'header/center',
            order: 50,
            enablement: 'panel.viewport.mounted',
          },
          {
            kind: 'control',
            id: 'viewport.center.separator',
            panelId: 'viewport',
            control: 'viewport.separator',
            location: 'header/center',
            order: 60,
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
            enablement: 'panel.viewport.canRedo',
          },
          {
            id: 'viewport.save.action',
            panelId: 'viewport',
            command: 'viewport.save',
            title: currentText(L('保存场景', 'Save scene')),
            icon: 'Save',
            testId: 'vp-save',
            location: 'header/right',
            order: 80,
            enablement: 'panel.viewport.mounted',
            highlightWhen: 'panel.viewport.dirty',
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
        onViewportQuadrantChange(() => syncViewportContext(host)),
        onGizmoModeChange(() => syncEditorContext(host)),
        onFpsChange(() => syncEditorContext(host)),
        onSceneListChange(() => syncEditorContext(host)),
        gateway.subscribe(() => syncEditorContext(host)),
      ];

      const dirtyTimer = window.setInterval(() => syncEditorContext(host), 500);
      cleanups.push(() => window.clearInterval(dirtyTimer));

      return () => {
        for (const cleanup of cleanups.slice().reverse()) cleanup();
      };
    },
  };
}

export const createViewportPanelContributionsExtension = createEditorPanelContributionsExtension;
