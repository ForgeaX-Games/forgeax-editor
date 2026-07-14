import { useState, useEffect, useRef, useLayoutEffect, useMemo, useReducer } from 'react';
import { WorkbenchSwitcher } from './WorkbenchSwitcher';
import { SessionSwitcher } from './SessionSwitcher';
import { ProjectSwitcher } from './ProjectSwitcher';
import { GameSwitcher } from './GameSwitcher';
import { AndroidPackageDialog, type AndroidPackageConfig } from './AndroidPackageDialog';
import { IosPackageDialog, type IosPackageConfig } from './IosPackageDialog';
import { STORAGE_KEYS } from '../../lib/storageKeys';
import { CircleGauge, LayoutGrid, Rocket, Settings, ShieldAlert, Check, X, Globe, Monitor, Laptop, Smartphone, Apple, ChevronDown, History, RefreshCw, Trash2, Loader2, Wrench, Eraser, UploadCloud, PlayCircle, FolderOpen, Copy, HelpCircle, Info, ChevronRight, CheckCircle2 } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '../ui/dropdown-menu';
import { useConfirmToast, type PendingConfirm } from '../../lib/useConfirmToast';
import { useSurface, type UISurfaceActionDef } from '../../lib/surface';
import { useShellStore } from '../../store';
import { useCommand } from '../../core/app-shell';
import { getWorkbenchClient } from '../../store';
import { usePanelRenderers } from '../DockShell/panelRenderers';
import { dashApi } from '../../lib/dashboard-api';
import { alertDialog, confirmDialog } from '../../lib/dialog';
import { listExtensions } from '../../lib/extension-api';
import { useTranslation } from '@/i18n';
import { PublishOnboarding } from './PublishOnboarding';
import { publishDoc } from './publish-options';
import './TopBar.css';

type BusCountState =
  | { kind: 'loading' }
  | { kind: 'down' }
  | { kind: 'ok'; pluginCount: number; brokenCount: number };

function useBusPluginCount(): BusCountState {
  const [state, setState] = useState<BusCountState>({ kind: 'loading' });
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await dashApi.health();
        if (cancelled) return;
        if (!r.bus) { setState({ kind: 'down' }); return; }
        setState({ kind: 'ok', pluginCount: r.bus.pluginCount, brokenCount: r.bus.brokenCount });
      } catch {
        if (cancelled) return;
        setState({ kind: 'down' });
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
  return state;
}

// P3.7 · Preview mode-tab count chip — completes the 3 mode-tab chip trio
// (Preview ⌘1 / Workbench ⌘2 / Bus ⌘3 each carry a count chip in the same
// shape but different color family). Source: /api/health.wsClients — the
// number of live UI WebSocket connections. Why this signal: Preview is
// where the engine renders + where /ws-events delivers run streaming, so
// wsClients is the natural "preview activity" indicator (open another
// browser tab and the count goes 2 → 3 live). Color is sky-blue, distinct
// from amber (workbench) and green (bus): "blue=observers / amber=
// workbench plugins / green=bus plugins" — three different surfaces in one
// scan. Reuses dashApi.health() (already cached for useBusPluginCount).
type PreviewCountState =
  | { kind: 'loading' }
  | { kind: 'down' }
  | { kind: 'ok'; wsClients: number };

function usePreviewWsCount(): PreviewCountState {
  const [state, setState] = useState<PreviewCountState>({ kind: 'loading' });
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await dashApi.health();
        if (cancelled) return;
        setState({ kind: 'ok', wsClients: r.wsClients });
      } catch {
        if (cancelled) return;
        setState({ kind: 'down' });
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
  return state;
}

// P3.5 · Workbench mode-tab count chip — symmetric with the Bus chip above.
// 公平地反映「Workbench mode 当前装载多少 wb-* plugin」。Source 是
// bus.plugins.list({kind:'workbench'})（同样的端点，Sidebar P2.6a 也在用）。
// 单独一次 fetch + 8s 轮询足够；不必跟 /api/health 共用（health 只暴露总数，
// 不分 kind），独立 hook 更解耦也更便于未来按其他 kind 扩展。
type WbCountState =
  | { kind: 'loading' }
  | { kind: 'down' }
  | { kind: 'ok'; count: number };

function useWorkbenchPluginCount(): WbCountState {
  const [state, setState] = useState<WbCountState>({ kind: 'loading' });
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await listExtensions('workbench');
        if (cancelled) return;
        setState({ kind: 'ok', count: r.count });
      } catch {
        if (cancelled) return;
        setState({ kind: 'down' });
      }
    };
    tick();
    const id = setInterval(tick, 8000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
  return state;
}

// P4.5 · TopBar tb-model BrainPill — until now the model pill in tb-right
// was a static `<span>` showing only the active model label (e.g. "Claude
// Opus 4.7"). Bus already hosts a `@forgeax-plugin/model-anthropic-text`
// model-binding plugin (kind=model-binding count=1) but no surface at the
// top right reflected that registration or let the player drill into it.
// Now: polls /api/extensions/list?kind=model-binding every 12s, decorates the
// pill with a teal #7be7c4 LED dot + small count suffix, and turns the
// span into a button. Click → setMode('bus') + setPendingBusKindFilter(
// 'model-binding') — same kind-only-no-expand deep-link pattern P4.3's
// tb-providers uses for cli-provider. Hover/focus/active states follow
// the existing tb-providers grammar but in teal so "color = kind" reads
// consistent with .cb-mb-row / .ba-chip.k-model-binding / .cp-bus-chip.
// k-model-binding everywhere else. Loading → dim pulsing dot; down →
// red dot fallback. This is also the first tb-right pill that points
// the player at a bus *kind that already has plugins registered* —
// previous pills (Vibe / Publish) were "coming soon" placeholders.
type MbCountState =
  | { kind: 'loading' }
  | { kind: 'down' }
  | { kind: 'ok'; count: number; ids: string[] };

function useModelBindingCount(): MbCountState {
  const [state, setState] = useState<MbCountState>({ kind: 'loading' });
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await listExtensions('model-binding');
        if (cancelled) return;
        setState({ kind: 'ok', count: r.count, ids: r.items.map((p) => p.id) });
      } catch {
        if (cancelled) return;
        setState({ kind: 'down' });
      }
    };
    tick();
    const id = setInterval(tick, 12000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
  return state;
}

// 2026-05-17 — useSkillCount / useToolCount / useAgentCount (P4.20-22) +
// their tb-skill / tb-tool / tb-agent buttons removed. Information mirrored
// by PreviewMode pt-right and Sidebar footer.  Lookup history at git log
// HEAD~/packages/interface/src/components/TopBar/TopBar.tsx if you need the
// previous JSX.

// P4.3 · TopBar tb-providers ProvidersBadge — surfaces CLI provider health
// roll-up directly in the tb-right pill row. Polls /api/cli-providers every
// 10s and renders `[● tone] PROV {ok}/{total}` between the model and Vibe
// pills. Three tones: lime (all ok) / amber (1+ down) / red (down/all-fail).
// Click → setMode('bus') + setPendingBusKindFilter('cli-provider') — the
// established deep-link pattern (AgentsHub already does this exact dispatch).
// Title lists each provider with ✓/✗ + detail so a quick hover surfaces the
// reason a provider is down without opening the dashboard.
type ProvHealthState =
  | { kind: 'loading' }
  | { kind: 'down' }
  | { kind: 'ok'; ok: number; total: number; rows: Array<{ id: string; ok: boolean; detail?: string }> };

function useCliProvidersHealth(): ProvHealthState {
  const [state, setState] = useState<ProvHealthState>({ kind: 'loading' });
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await dashApi.providers();
        if (cancelled) return;
        const rows = r.providers.map((p) => ({
          id: p.id,
          ok: !!p.health?.ok,
          detail: p.health?.detail,
        }));
        const ok = rows.filter((p) => p.ok).length;
        setState({ kind: 'ok', ok, total: rows.length, rows });
      } catch {
        if (cancelled) return;
        setState({ kind: 'down' });
      }
    };
    tick();
    const id = setInterval(tick, 10000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
  return state;
}

function TbDivider() {
  return <span className="tb-divider" aria-hidden="true" />;
}

// DUAL-MODALITY 9.9 — host.toast surface schema. Mirrors the pending-confirm
// list rendered by ConfirmToastList so AI can read what the player currently
// sees as a confirm prompt. allow / deny actions are NOT exposed to AI on
// purpose: AI must not auto-confirm its own pending tool calls.
const HOST_TOAST_SCHEMA = {
  type: 'object',
  properties: {
    pending: {
      type: 'array',
      items: {
        type: 'object',
        required: ['token', 'toolId', 'callerKind', 'receivedAt'],
        properties: {
          token: { type: 'string' },
          toolId: { type: 'string' },
          callerKind: { type: 'string' },
          reason: { type: 'string' },
          receivedAt: { type: 'number' },
        },
      },
    },
  },
} as const;

interface HostToastSnapshot {
  pending: Array<{
    token: string;
    toolId: string;
    callerKind: string;
    reason?: string;
    receivedAt: number;
  }>;
}

// ConfirmToastList — renders pending tool.confirm-required toasts below the TopBar.
// Each toast shows toolId + caller info plus confirm/deny buttons.
// POST /api/tools/confirm is handled by useConfirmToast's ack/deny callbacks.
interface ConfirmToastListProps {
  confirms: PendingConfirm[];
  onAck: (token: string) => void;
  onDeny: (token: string) => void;
}

function ConfirmToastList({ confirms, onAck, onDeny }: ConfirmToastListProps) {
  if (confirms.length === 0) return null;
  return (
    <div className="tb-confirm-list" role="status" aria-live="polite">
      {confirms.map((c) => (
        <div key={c.token} className="tb-confirm-toast" role="alert">
          <ShieldAlert size={14} className="tb-confirm-icon" />
          <span className="tb-confirm-label">
            <strong>{c.toolId}</strong>
            <span className="tb-confirm-caller">{c.caller.kind}</span>
            {c.message && <span className="tb-confirm-reason">{c.message}</span>}
            {!c.message && c.reason && <span className="tb-confirm-reason">{c.reason}</span>}
          </span>
          <div className="tb-confirm-actions">
            <button
              type="button"
              className="tb-confirm-btn tb-confirm-btn--allow"
              onClick={() => onAck(c.token)}
              title={`Allow tool: ${c.toolId}`}
            >
              <Check size={12} />
              Allow
            </button>
            <button
              type="button"
              className="tb-confirm-btn tb-confirm-btn--deny"
              onClick={() => onDeny(c.token)}
              title={`Deny tool: ${c.toolId}`}
            >
              <X size={12} />
              Deny
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// WorkbenchSwitcher + modeForWorkbench extracted → ./WorkbenchSwitcher (§D).

interface EngineRootCandidate {
  path: string;
  label: string;
  valid: boolean;
  recommended: boolean;
}

export function TopBar() {
  const { t } = useTranslation();
  const hasChatSurface = Boolean(usePanelRenderers().panels?.chat);
  const { mode, setMode } = useShellStore();
  const openOverlay = useShellStore((s) => s.openOverlay);
  const pinnedSlug = useShellStore((s) => s.pinnedSlug);
  // Route the LayoutGrid button through the command bus so keyboard / palette /
  // iframe all share one entry (was: window.dispatchEvent(APP_EVENTS.dockLayoutToggle)).
  const dockLayoutToggle = useCommand<{ rect?: { top: number; bottom: number; left: number; right: number } }>('app.dock.layoutToggle');
  const [packaging, setPackaging] = useState(false);
  const [packagingPlatform, setPackagingPlatform] = useState('');
  const [rebuildEngine, setRebuildEngine] = useState(false);
  const [engineRoots, setEngineRoots] = useState<EngineRootCandidate[]>([]);
  const [selectedEngineRoot, setSelectedEngineRoot] = useState<string | undefined>(undefined);
  const [showHistory, setShowHistory] = useState(false);
  const [showProgress, setShowProgress] = useState(false);
  const [progressPhase, setProgressPhase] = useState('');
  const [progressLogs, setProgressLogs] = useState<string[]>([]);
  const [cleaning, setCleaning] = useState(false);
  const [androidDialog, setAndroidDialog] = useState<{ slug: string; defaultAppName: string } | null>(null);
  const [iosDialog, setIosDialog] = useState<{ slug: string; defaultAppName: string } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [onboardActive, setOnboardActive] = useState(false);
  const { pendingConfirms, ack, deny } = useConfirmToast();

  // Publish dropdown open-state is controlled so the first-run coach-mark can
  // drive it (open it on option steps, close it on the intro). While the tour
  // is active it owns menuOpen entirely — Radix's own open/close requests are
  // ignored. On the very first open we kick off the tour instead.
  const handleMenuOpenChange = (open: boolean) => {
    if (onboardActive) return;
    if (open && !localStorage.getItem(STORAGE_KEYS.publishOnboarded)) {
      localStorage.setItem(STORAGE_KEYS.publishOnboarded, '1');
      setMenuOpen(false);
      setOnboardActive(true);
      return;
    }
    setMenuOpen(open);
  };

  type TargetPlatform = 'web' | 'windows' | 'macos' | 'android' | 'ios';

  // Detect engine-root candidates for the standalone export. The export script
  // must run inside an engine root that has its deps (vite, @forgeax/*) — the
  // live one is play-runtime, not the legacy engine-src.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const j = await getWorkbenchClient().getEngineRoots();
        if (cancelled) return;
        const roots = (j.roots ?? []) as unknown as EngineRootCandidate[];
        setEngineRoots(roots);
        const recommended = roots.find((x) => x.recommended) ?? roots.find((x) => x.valid);
        if (recommended) setSelectedEngineRoot(recommended.path);
      } catch { /* leave empty — backend auto-detects on package */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Resolve the game slug to package: the pinned one, else the active game.
  const resolvePackageSlug = async (): Promise<string | null> => {
    let slug = pinnedSlug;
    if (!slug) {
      try {
        const j = await getWorkbenchClient().getActiveSlug();
        slug = j.activeSlug ?? null;
      } catch { /* fall through */ }
    }
    return slug ?? null;
  };

  // Android needs user config (applicationId / name / icon / orientation) before
  // packaging, so it opens a dialog first and calls onPackageGame from onConfirm.
  const openAndroidDialog = async () => {
    if (packaging) return;
    const slug = await resolvePackageSlug();
    if (!slug) {
      await alertDialog({ title: t('topbar.package.title'), body: t('topbar.package.noGame') });
      return;
    }
    setAndroidDialog({ slug, defaultAppName: slug });
  };

  // iOS also needs user config (bundleId / name / icon / orientation) before
  // packaging, so it opens a dialog first and calls onPackageGame from onConfirm.
  const openIosDialog = async () => {
    if (packaging) return;
    const slug = await resolvePackageSlug();
    if (!slug) {
      await alertDialog({ title: t('topbar.package.title'), body: t('topbar.package.noGame') });
      return;
    }
    setIosDialog({ slug, defaultAppName: slug });
  };

  const onPackageGame = async (platform: TargetPlatform, cfg?: AndroidPackageConfig | IosPackageConfig) => {
    if (packaging) return;
    const slug = await resolvePackageSlug();
    if (!slug) {
      await alertDialog({ title: t('topbar.package.title'), body: t('topbar.package.noGame') });
      return;
    }
    setPackaging(true);
    setPackagingPlatform(platform);
    try {
      const j = await getWorkbenchClient().packageGame(slug, {
        targetPlatform: platform,
        rebuildEngine,
        forceRebuild: false,
        engineRoot: selectedEngineRoot,
        ...(cfg ?? {}),
      });

      // Async job (Windows / native platforms)
      if (j.async && typeof j.jobId === 'string') {
        setShowProgress(true);
        setProgressPhase('starting');
        setProgressLogs([]);
        await pollJob(j.jobId as string, slug!, platform);
        return;
      }

      // Synchronous result (Web)
      if (!j.ok) {
        await alertDialog({
          title: t('topbar.package.failed'),
          body: <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 12 }}>{String(j.detail || j.error || t('topbar.package.unknownError'))}</pre>,
        });
        return;
      }
      await alertDialog({
        title: t('topbar.package.done', { slug, platform }),
        body: (
          <PackageSuccessBody
            outDir={String(j.outDir ?? '')}
            runHint={String(j.runHint ?? '')}
            platform={platform}
            slug={slug!}
            t={t}
          />
        ),
      });
    } catch (e) {
      await alertDialog({ title: t('topbar.package.failed'), body: String((e as Error)?.message ?? e) });
    } finally {
      setPackaging(false);
      setPackagingPlatform('');
    }
  };

  const pollJob = async (jobId: string, slug: string, platform: string) => {
    const INTERVAL = 1500;
    const MAX_POLLS = 400;
    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise(r => setTimeout(r, INTERVAL));
      try {
        const job = (await getWorkbenchClient().pollPackageJob(jobId)) as unknown as {
          status: string;
          phase: string;
          logTail: string[];
          result?: Record<string, unknown>;
        };
        setProgressPhase(job.phase);
        setProgressLogs(job.logTail.slice(-30));

        if (job.status === 'success' || job.status === 'failed') {
          setShowProgress(false);
          setPackaging(false);
          setPackagingPlatform('');
          if (job.status === 'success') {
            const res = job.result ?? {};
            await alertDialog({
              title: t('topbar.package.done', { slug, platform }),
              body: (
                <PackageSuccessBody
                  outDir={String(res.outDir ?? '')}
                  runHint={String(res.runHint ?? '')}
                  platform={platform}
                  slug={slug}
                  usedCachedShell={Boolean(res.usedCachedShell)}
                  t={t}
                />
              ),
            });
          } else {
            const res = job.result ?? {};
            await alertDialog({
              title: t('topbar.package.failed'),
              body: <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 12 }}>{String(res.detail || res.error || t('topbar.package.unknownError'))}</pre>,
            });
          }
          return;
        }
      } catch { /* continue polling */ }
    }
    setShowProgress(false);
    setPackaging(false);
    setPackagingPlatform('');
  };

  const onRetryPackage = async (slug: string, platform: string) => {
    setPackaging(true);
    setPackagingPlatform(platform);
    setShowHistory(false);
    try {
      const j = await getWorkbenchClient().packageGame(slug, {
        targetPlatform: platform,
        forceRebuild: true,
        engineRoot: selectedEngineRoot,
      });
      if (j.async && typeof j.jobId === 'string') {
        setShowProgress(true);
        setProgressPhase('starting');
        setProgressLogs([]);
        await pollJob(j.jobId as string, slug, platform);
      }
    } catch (e) {
      await alertDialog({ title: t('topbar.package.failed'), body: String((e as Error)?.message ?? e) });
    } finally {
      setPackaging(false);
      setPackagingPlatform('');
    }
  };

  const onCleanCache = async () => {
    if (packaging) return;
    if (!(await confirmDialog({
      title: t('topbar.package.cleanTitle'),
      body: (
        <div style={{ fontSize: 13, lineHeight: 1.6 }}>
          <div>{t('topbar.package.cleanBody')}</div>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, opacity: 0.85 }}>
            <li>{t('topbar.package.cleanItemToolchain')}</li>
            <li>{t('topbar.package.cleanItemShell')}</li>
            <li>{t('topbar.package.cleanItemTmp')}</li>
          </ul>
          <div style={{ marginTop: 8, opacity: 0.7 }}>{t('topbar.package.cleanKeepHint')}</div>
        </div>
      ),
      danger: true,
      confirmText: t('topbar.package.cleanConfirm'),
    }))) return;

    setCleaning(true);
    try {
      const j = await getWorkbenchClient().cleanPackage();
      const fmtSize = (b: number): string => {
        if (b <= 0) return '0 B';
        const u = ['B', 'KB', 'MB', 'GB']; let i = 0; let n = b;
        while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
        return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
      };
      const anyError = j.targets.some((tg) => Boolean(tg.error));
      setCleaning(false);
      await alertDialog({
        title: anyError ? t('topbar.package.cleanPartial') : t('topbar.package.cleanDone'),
        body: (
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>
            <div>{t('topbar.package.cleanFreed', { size: fmtSize(j.totalBytes) })}</div>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12 }}>
              {j.targets.map((tg) => (
                <li key={tg.path} style={{ opacity: tg.existed ? 1 : 0.5 }}>
                  {tg.error ? '✗' : tg.removed ? '✓' : '·'} {tg.path}
                  {tg.removed && tg.bytes > 0 ? ` (${fmtSize(tg.bytes)})` : ''}
                  {tg.error ? ` — ${tg.error}` : ''}
                </li>
              ))}
            </ul>
          </div>
        ),
      });
    } catch (e) {
      setCleaning(false);
      await alertDialog({ title: t('topbar.package.cleanFailed'), body: String((e as Error)?.message ?? e) });
    }
  };

  // DUAL-MODALITY 9.9 — register host.toast surface so the AI can read the
  // pending-confirm prompts the player currently sees. Snapshot mirrors
  // pendingConfirms (slim shape — drops the caller blob besides kind). Actions
  // allow/deny are exposedToAI=false to prevent AI from greenlighting its own
  // gated tool calls; only the player path (button click) drives them.
  const toastPendingSlim = useMemo<HostToastSnapshot['pending']>(
    () => pendingConfirms.map((c) => ({
      token: c.token,
      toolId: c.toolId,
      callerKind: c.caller.kind,
      reason: c.reason,
      receivedAt: c.receivedAt,
    })),
    [pendingConfirms],
  );
  const toastSurface = useSurface<HostToastSnapshot, Record<string, UISurfaceActionDef>>({
    id: 'host.toast',
    layer: 'host',
    schema: HOST_TOAST_SCHEMA as unknown as Record<string, unknown>,
    initialSnapshot: { pending: toastPendingSlim },
    actions: {
      allow: {
        id: 'allow',
        exposedToAI: false,
        argsSchema: { type: 'object', required: ['token'], properties: { token: { type: 'string' } } },
        run: (raw) => {
          const a = (raw ?? {}) as { token?: unknown };
          if (typeof a.token !== 'string') return;
          void ack(a.token);
        },
      },
      deny: {
        id: 'deny',
        exposedToAI: false,
        argsSchema: { type: 'object', required: ['token'], properties: { token: { type: 'string' } } },
        run: (raw) => {
          const a = (raw ?? {}) as { token?: unknown };
          if (typeof a.token !== 'string') return;
          void deny(a.token);
        },
      },
    },
  });
  useEffect(() => {
    toastSurface.setSnapshot({ pending: toastPendingSlim });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toastPendingSlim]);
  // 2026-05-21 — TopBar 不再渲染模型选择器。原本 tb-right 挂了
  // `<ModelPicker variant="pill">` 当真实选择器,但 Composer 底部也有一份,
  // 两个 picker 各自跟 agent.json 异步轮询时会出现展示不一致(顶部还显示
  // 上一次的 selected,底部已经切了),用户明确反馈"为什么有好几个选模型
  // 的地方"。SSOT 收回 Composer (`ChatPanel/Composer.tsx <ModelPicker>`),
  // TopBar 只留 Settings 入口和 cli-provider admin 快捷键。
  // 2026-05-17 — useBusPluginCount / useWorkbenchPluginCount / usePreviewWsCount
  // hooks no longer wired (count badges were removed). The function bodies are
  // kept in this file for the moment in case future TopBar widgets want them;
  // the unused-imports lint warning is tolerated.
  // provHealth / mbCount hooks removed — pills collapsed to icon buttons (no count badges).
  // Workspace tabs replace the old fixed mode tabs.
  return (
    <>
    <div className="topbar">
      <div className="tb-left" data-tour-id="tb-left">
        {/* Decorative macOS-style traffic dots — 2026-07-08 removed.
           Browser: the browser window itself already has real traffic lights
           at the OS level, so drawing our own inside the app chrome is a
           visual dup. Tauri: OS draws the real (functional) ones, same dup.
           Neither host needs fake dots; they were a P4.65 skin holdover. */}
        {/* 2026-06-02 — removed the standalone "+" (NewMenu): its "新建 game" /
            "新建 session" duplicated the per-selector create actions. Each
            selector now owns its own pinned "新建 X": workspace → ProjectSwitcher,
            game → GameSwitcher, session → SessionSwitcher. */}
        <ProjectSwitcher />
        <TbDivider />
        <GameSwitcher />
        {/* Forge agent entry region appears only when the host injects chat. */}
        {hasChatSurface && (
          <span data-testid="forge-entry" style={{ display: 'contents' }}>
            <TbDivider />
            <SessionSwitcher />
          </span>
        )}
      </div>

      <WorkbenchSwitcher setMode={setMode} />

      <div className="tb-right" data-tour-id="tb-right">
        <DashboardToggle />
        <TbDivider />
        <button
          type="button"
          className="tb-icon-btn"
          title={t('topbar.layout.tooltip')}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            void dockLayoutToggle({ rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right } });
          }}
        >
          <LayoutGrid size={16} />
        </button>
        <TbDivider />
        <button
          type="button"
          className="tb-icon-btn"
          onClick={() => openOverlay('settings')}
          title={t('topbar.settings.tooltip')}
        >
          <Settings size={16} />
        </button>
        <TbDivider />
        <DropdownMenu open={menuOpen} onOpenChange={handleMenuOpenChange} modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="tb-publish-btn"
              disabled={packaging}
              title={packaging ? t('topbar.publish.packaging', { platform: packagingPlatform }) : t('topbar.publish.tooltip')}
            >
              <Rocket size={16} />
              <ChevronDown size={10} style={{ marginLeft: 2, opacity: 0.6 }} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={6} className="tb-publish-menu">
            <DropdownMenuLabel>{t('topbar.package.menuTitle')}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem data-onboard="web" title={publishDoc(t, 'web').what} onClick={() => onPackageGame('web')}>
              <Globe size={14} />
              <span className="tb-mi-txt">
                <span className="tb-mi-title">{t('topbar.package.platformWeb')}</span>
                <span className="tb-mi-sub">{publishDoc(t, 'web').when}</span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem data-onboard="windows" title={publishDoc(t, 'windows').what} onClick={() => onPackageGame('windows')}>
              <Monitor size={14} />
              <span className="tb-mi-txt">
                <span className="tb-mi-title">{t('topbar.package.platformWindows')}</span>
                <span className="tb-mi-sub">{publishDoc(t, 'windows').when}</span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem data-onboard="macos" title={publishDoc(t, 'macos').what} onClick={() => onPackageGame('macos')}>
              <Laptop size={14} />
              <span className="tb-mi-txt">
                <span className="tb-mi-title">{t('topbar.package.platformMac')}</span>
                <span className="tb-mi-sub">{publishDoc(t, 'macos').when}</span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem data-onboard="android" disabled={packaging} title={publishDoc(t, 'android').what} onClick={() => { void openAndroidDialog(); }}>
              <Smartphone size={14} />
              <span className="tb-mi-txt">
                <span className="tb-mi-title">{t('topbar.package.platformAndroid')}</span>
                <span className="tb-mi-sub">{publishDoc(t, 'android').when}</span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem data-onboard="ios" disabled={packaging} title={publishDoc(t, 'ios').what} onClick={() => { void openIosDialog(); }}>
              <Apple size={14} />
              <span className="tb-mi-txt">
                <span className="tb-mi-title">{t('topbar.package.platformIos')}</span>
                <span className="tb-mi-sub">{publishDoc(t, 'ios').when}</span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {/* Coming soon — one-click cloud/platform publish is a grayed placeholder. */}
            <DropdownMenuItem disabled title={publishDoc(t, 'cloud').what}>
              <UploadCloud size={14} />
              <span className="tb-mi-txt">
                <span className="tb-mi-title">{t('topbar.package.platformCloud')}</span>
                <span className="tb-mi-sub">{t('topbar.package.comingSoon')}</span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel style={{ fontSize: 11, opacity: 0.6 }} title={publishDoc(t, 'engineRoot').what}>{t('topbar.package.engineRoot')}</DropdownMenuLabel>
            {engineRoots.length === 0 ? (
              <DropdownMenuItem disabled style={{ fontSize: 11, opacity: 0.5 }}>
                {t('topbar.package.engineRootNone')}
              </DropdownMenuItem>
            ) : (
              engineRoots.map((root) => (
                <DropdownMenuItem
                  key={root.path}
                  disabled={!root.valid}
                  onClick={(e) => { e.preventDefault(); if (root.valid) setSelectedEngineRoot(root.path); }}
                  style={{ gap: 6, opacity: root.valid ? 1 : 0.45 }}
                  title={root.path}
                >
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {root.label}
                    {!root.valid && <span style={{ marginLeft: 4, fontSize: 10, opacity: 0.7 }}>({t('topbar.package.engineRootInvalid')})</span>}
                  </span>
                  <span style={{ width: 14, height: 14, borderRadius: 3, border: '1px solid #666', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10 }}>
                    {selectedEngineRoot === root.path ? '✓' : ''}
                  </span>
                </DropdownMenuItem>
              ))
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-onboard="engine"
              title={publishDoc(t, 'engine').what}
              onClick={(e) => { e.preventDefault(); setRebuildEngine(!rebuildEngine); }}
              style={{ gap: 6 }}
            >
              <Wrench size={14} />
              <span className="tb-mi-txt">
                <span className="tb-mi-title">{t('topbar.package.rebuildEngine')}</span>
                <span className="tb-mi-sub">{publishDoc(t, 'engine').when}</span>
              </span>
              <span style={{ width: 14, height: 14, borderRadius: 3, border: '1px solid #666', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10 }}>
                {rebuildEngine ? '✓' : ''}
              </span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem data-onboard="history" title={publishDoc(t, 'history').what} onClick={() => setShowHistory(true)}>
              <History size={14} />
              {t('topbar.package.history')}
            </DropdownMenuItem>
            <DropdownMenuItem
              data-onboard="clean"
              title={publishDoc(t, 'clean').what}
              onClick={(e) => { e.preventDefault(); void onCleanCache(); }}
              style={{ gap: 6, color: 'var(--destructive, #e05260)' }}
            >
              <Eraser size={14} />
              {t('topbar.package.clean')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={(e) => { e.preventDefault(); setOnboardActive(true); }}>
              <HelpCircle size={14} />
              {t('topbar.package.viewGuide')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <PublishOnboarding
          active={onboardActive}
          onClose={() => setOnboardActive(false)}
          setMenuOpen={setMenuOpen}
          t={t}
        />
      </div>
    </div>
    <ConfirmToastList confirms={pendingConfirms} onAck={ack} onDeny={deny} />
    {cleaning && (
      <div className="tb-progress-overlay">
        <div className="tb-progress-dialog">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Loader2 size={16} className="tb-spinner" />
            <span style={{ fontWeight: 600 }}>{t('topbar.package.cleaning')}</span>
          </div>
          <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>{t('topbar.package.cleaningHint')}</div>
        </div>
      </div>
    )}
    {showProgress && <PackageProgressOverlay phase={progressPhase} logs={progressLogs} platform={packagingPlatform} onClose={() => { setShowProgress(false); }} t={t} />}
    {showHistory && <PackageHistoryDialog onClose={() => setShowHistory(false)} onRetry={onRetryPackage} t={t} />}
    {androidDialog && (
      <AndroidPackageDialog
        slug={androidDialog.slug}
        defaultAppName={androidDialog.defaultAppName}
        t={t}
        onCancel={() => setAndroidDialog(null)}
        onConfirm={(cfg) => { setAndroidDialog(null); void onPackageGame('android', cfg); }}
      />
    )}
    {iosDialog && (
      <IosPackageDialog
        slug={iosDialog.slug}
        defaultAppName={iosDialog.defaultAppName}
        t={t}
        onCancel={() => setIosDialog(null)}
        onConfirm={(cfg) => { setIosDialog(null); void onPackageGame('ios', cfg); }}
      />
    )}
    </>
  );
}

// GameSwitcher + NewGameModal + timeSince extracted → ./GameSwitcher (§D).

// ── PackageSuccessBody ──
// The body of the "packaging done" dialog. Turns the old read-only outDir /
// runHint text into actionable buttons: one-click playtest (web), open the
// product folder in the OS file manager, and copy the path / run command.
function PackageSuccessBody({ outDir, runHint, platform, slug, usedCachedShell, t }: {
  outDir: string;
  runHint: string;
  platform: string;
  slug: string;
  usedCachedShell?: boolean;
  t: (k: string, opts?: Record<string, string | number>) => string;
}) {
  const [copied, setCopied] = useState<'path' | 'cmd' | null>(null);

  const copy = async (text: string, which: 'path' | 'cmd') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied((c) => (c === which ? null : c)), 1600);
    } catch { /* ignore */ }
  };
  const reveal = async () => {
    try { await fetch('/api/workbench/package/reveal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: outDir }) }); } catch { /* ignore */ }
  };
  // Playtest is served by the studio server itself (same-origin, secure
  // localhost context, correct .wasm MIME) — no npx/serve.sh spawn, so the tab
  // opens instantly onto a ready server instead of a maybe-not-bound one.
  const play = () => {
    window.open(`/api/workbench/play/${encodeURIComponent(slug)}/`, '_blank');
  };

  const isWeb = platform === 'web';

  return (
    <div className="tb-pkg-success">
      <div className="tb-pkg-head">
        <CheckCircle2 size={20} className="tb-pkg-head-ic" />
        <span className="tb-pkg-head-txt">{t('topbar.package.success.ready')}</span>
      </div>

      <div className="tb-pkg-path">
        <FolderOpen size={14} className="tb-pkg-path-ic" />
        <code className="tb-pkg-path-txt">{outDir}</code>
      </div>

      <div className="tb-success-actions">
        {isWeb && (
          <button type="button" className="tb-sa-btn primary" onClick={play}>
            <PlayCircle size={18} />
            <span>{t('topbar.package.success.play')}</span>
          </button>
        )}
        <button type="button" className={`tb-sa-btn${isWeb ? '' : ' primary'}`} onClick={() => { void reveal(); }}>
          <FolderOpen size={18} />
          <span>{t('topbar.package.success.open')}</span>
        </button>
        <button type="button" className="tb-sa-btn" onClick={() => { void copy(outDir, 'path'); }}>
          {copied === 'path' ? <Check size={18} /> : <Copy size={18} />}
          <span>{copied === 'path' ? t('topbar.package.success.copied') : t('topbar.package.success.copyPath')}</span>
        </button>
        {runHint && (
          <button type="button" className="tb-sa-btn" onClick={() => { void copy(runHint, 'cmd'); }}>
            {copied === 'cmd' ? <Check size={18} /> : <Copy size={18} />}
            <span>{copied === 'cmd' ? t('topbar.package.success.copied') : t('topbar.package.success.copyCmd')}</span>
          </button>
        )}
      </div>

      {runHint && (
        <details className="tb-pkg-cmd">
          <summary><ChevronRight size={13} className="tb-pkg-cmd-caret" />{t('topbar.package.runLocally')}</summary>
          <pre>{runHint}</pre>
        </details>
      )}

      {usedCachedShell && (
        <div className="tb-pkg-hint"><Info size={13} /><span>{t('topbar.package.cachedShell')}</span></div>
      )}
      {isWeb && (
        <div className="tb-pkg-hint"><Info size={13} /><span>{t('topbar.package.webgpuHint')}</span></div>
      )}
    </div>
  );
}

// ── PackageProgressOverlay ──
// A polished "packaging in progress" card: an animated orb + humanized phase
// label, an indeterminate shimmer bar (we have no % from the backend), the
// latest build line, a reassuring hint, and a collapsible terminal log.
function PackageProgressOverlay({ phase, logs, platform, onClose, t }: {
  phase: string;
  logs: string[];
  platform?: string;
  onClose: () => void;
  t: (k: string, opts?: Record<string, string | number>) => string;
}) {
  const logsRef = useRef<HTMLPreElement>(null);
  const [showLogs, setShowLogs] = useState(false);
  useEffect(() => {
    if (logsRef.current) logsRef.current.scrollTop = logsRef.current.scrollHeight;
  }, [logs, showLogs]);

  // Humanize the phase; fall back to the raw phase if no label key exists.
  const labelKey = `topbar.package.phaseLabel.${phase}`;
  const label = t(labelKey);
  const phaseText = label === labelKey || label.startsWith('topbar.') ? phase : label;
  const lastLine = logs.length ? logs[logs.length - 1] : '';

  return (
    <div className="tb-progress-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="tb-progress-dialog tb-prog">
        <div className="tb-prog-head">
          <span className="tb-prog-orb"><Loader2 size={20} className="tb-spinner" /></span>
          <div className="tb-prog-headtxt">
            <div className="tb-prog-title">
              {t('topbar.package.progressTitle')}
              {platform && <span className="tb-prog-badge">{platform}</span>}
            </div>
            <div className="tb-prog-phase">{phaseText}</div>
          </div>
        </div>

        <div className="tb-prog-bar" role="progressbar" aria-label={phaseText}><span /></div>

        {lastLine && <div className="tb-prog-line">{lastLine}</div>}
        <div className="tb-prog-hint">{t('topbar.package.progressHint')}</div>

        <details
          className="tb-prog-logbox"
          onToggle={(e) => setShowLogs((e.currentTarget as HTMLDetailsElement).open)}
        >
          <summary><ChevronRight size={13} className="tb-prog-caret" />{t('topbar.package.progressLogs')}</summary>
          <pre ref={logsRef}>{logs.join('\n') || '…'}</pre>
        </details>

        <div className="tb-prog-foot">
          <button type="button" className="tb-prog-close" onClick={onClose}>{t('topbar.package.progressClose')}</button>
        </div>
      </div>
    </div>
  );
}

// ── PackageHistoryDialog ──
interface HistoryRecord {
  id: string;
  slug: string;
  platform: string;
  status: 'success' | 'failed';
  createdAt: number;
  durationMs: number;
  outDir?: string;
  error?: string;
  usedCachedShell?: boolean;
  rebuiltEngine?: boolean;
}

function PackageHistoryDialog({ onClose, onRetry, t }: {
  onClose: () => void;
  onRetry: (slug: string, platform: string) => void;
  t: (k: string, opts?: Record<string, string | number>) => string;
}) {
  const [records, setRecords] = useState<HistoryRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchHistory = async () => {
    try {
      const j = await getWorkbenchClient().listPackageHistory();
      setRecords((j.records ?? []) as unknown as HistoryRecord[]);
    } catch { /* empty */ }
    setLoading(false);
  };

  useEffect(() => { fetchHistory(); }, []);

  const handleDelete = async (id: string) => {
    try {
      await getWorkbenchClient().deletePackageHistory(id, { clean: true });
      setRecords(prev => prev.filter(r => r.id !== id));
    } catch { /* ignore */ }
  };

  const fmtDate = (ts: number) => new Date(ts).toLocaleString();
  const fmtDuration = (ms: number) => ms >= 60000 ? `${(ms / 60000).toFixed(1)}m` : `${(ms / 1000).toFixed(1)}s`;

  return (
    <div className="tb-progress-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="tb-progress-dialog" style={{ minWidth: 420, maxHeight: '70vh' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{t('topbar.package.history')}</span>
          <button type="button" onClick={onClose} style={{ fontSize: 12, cursor: 'pointer', background: 'none', border: 'none', color: 'inherit' }}>✕</button>
        </div>
        {loading && <div style={{ textAlign: 'center', padding: 20, opacity: 0.6 }}>…</div>}
        {!loading && records.length === 0 && (
          <div style={{ textAlign: 'center', padding: 20, opacity: 0.6 }}>{t('topbar.package.historyEmpty')}</div>
        )}
        <div style={{ overflowY: 'auto', maxHeight: 'calc(70vh - 80px)' }}>
          {records.map((rec) => (
            <div key={rec.id} style={{
              padding: '8px 10px', borderBottom: '1px solid rgba(255,255,255,0.06)',
              display: 'flex', alignItems: 'center', gap: 8, fontSize: 12,
            }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: rec.status === 'success' ? '#4ade80' : '#f87171', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500 }}>
                  {rec.slug} — {rec.platform}
                  {rec.usedCachedShell && <span style={{ opacity: 0.5, marginLeft: 4 }}>(cached)</span>}
                </div>
                <div style={{ opacity: 0.6 }}>
                  {fmtDate(rec.createdAt)} · {fmtDuration(rec.durationMs)}
                  {rec.error && <span style={{ color: '#f87171', marginLeft: 4 }}>{rec.error.slice(0, 60)}</span>}
                </div>
              </div>
              {rec.status === 'failed' && (
                <button type="button" onClick={() => onRetry(rec.slug, rec.platform)}
                  style={{ fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3, padding: '2px 6px', borderRadius: 3, border: '1px solid rgba(255,255,255,0.15)', background: 'transparent', color: 'inherit' }}
                  title={t('topbar.package.historyRetry')}>
                  <RefreshCw size={11} /> {t('topbar.package.historyRetry')}
                </button>
              )}
              <button type="button" onClick={() => handleDelete(rec.id)}
                style={{ fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3, padding: '2px 6px', borderRadius: 3, border: '1px solid rgba(255,255,255,0.1)', background: 'transparent', color: 'inherit', opacity: 0.6 }}
                title={t('topbar.package.historyDelete')}>
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DashboardToggle() {
  const dashboardOpen = useShellStore((s) => s.activeOverlay === 'dashboard');
  const openOverlay = useShellStore((s) => s.openOverlay);
  const closeOverlay = useShellStore((s) => s.closeOverlay);
  return (
    <button
      className={`tb-icon-btn${dashboardOpen ? ' active' : ''}`}
      onClick={() => (dashboardOpen ? closeOverlay() : openOverlay('dashboard'))}
      title="Dashboard — Run/Thread/Provider monitoring"
    >
      <CircleGauge size={16} />
    </button>
  );
}

