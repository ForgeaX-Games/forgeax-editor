import { useState, useEffect, useRef, useLayoutEffect, useMemo, useReducer } from 'react';
import { WorkspaceTabs } from './WorkspaceTabs';
import { SessionSwitcher } from './SessionSwitcher';
import { ProjectSwitcher } from './ProjectSwitcher';
import { GameSwitcher } from './GameSwitcher';
import { STORAGE_KEYS, APP_EVENTS } from '../../lib/storageKeys';
import { CircleGauge, LayoutGrid, Rocket, Settings, ShieldAlert, Check, X } from 'lucide-react';
import { useConfirmToast, type PendingConfirm } from '../../lib/useConfirmToast';
import { useSurface, type UISurfaceActionDef } from '../../lib/surface';
// SettingsDrawer is no longer rendered from here — its body migrated into
// the SettingsPanel overlay (see App.tsx).  We still import its Section /
// EnvField helpers from this file via SectionsRegister.tsx.
import { useAppStore } from '../../store';
import { isTauri } from '../../lib/platform/runtime';
import { dashApi } from '../../lib/dashboard-api';
import { alertDialog } from '../../lib/dialog';
import { listBusPlugins } from '../../lib/bus-api';
import { useTranslation } from '@/i18n';
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
        const r = await listBusPlugins('workbench');
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
// Now: polls /api/bus/plugins?kind=model-binding every 12s, decorates the
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
        const r = await listBusPlugins('model-binding');
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
            {c.reason && <span className="tb-confirm-reason">{c.reason}</span>}
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

// WorkspaceTabs + modeForWorkspace extracted → ./WorkspaceTabs (§D).

export interface TopBarProps {
  /**
   * BANDAGE — when `true`, the TopBar omits the Forge agent entry region
   * (the SessionSwitcher cluster, anchored as `data-testid="forge-entry"`).
   * Drilled in from App.tsx for the standalone editor host
   * (`packages/editor/standalone/main.tsx`). When `false` / omitted, the
   * full studio TopBar renders unchanged. See plan-strategy section 2 D-4
   * + D-9 and ADR-0018 for the bandage rationale and scheduled removal.
   */
  hideChatAndForge?: boolean;
}

export function TopBar({ hideChatAndForge }: TopBarProps = {}) {
  const { t } = useTranslation();
  const { mode, setMode } = useAppStore();
  const openSettings = useAppStore((s) => s.openSettings);
  const pinnedSlug = useAppStore((s) => s.pinnedSlug);
  const [packaging, setPackaging] = useState(false);
  const { pendingConfirms, ack, deny } = useConfirmToast();

  // Package the current game into a standalone bundle that runs locally
  // (no studio server). Server builds it under .forgeax/exports/<slug>/.
  const onPackageGame = async () => {
    if (packaging) return;
    let slug = pinnedSlug;
    if (!slug) {
      try {
        const r = await fetch('/api/workbench/active-slug');
        slug = ((await r.json()) as { activeSlug?: string | null }).activeSlug ?? null;
      } catch { /* fall through */ }
    }
    if (!slug) {
      await alertDialog({ title: t('topbar.package.title'), body: t('topbar.package.noGame') });
      return;
    }
    setPackaging(true);
    try {
      const r = await fetch(`/api/workbench/games/${slug}/package`, { method: 'POST' });
      const j = (await r.json()) as { ok?: boolean; error?: string; detail?: string; outDir?: string; runHint?: string };
      if (!r.ok || !j.ok) {
        await alertDialog({
          title: t('topbar.package.failed'),
          body: <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 12 }}>{j.detail || j.error || t('topbar.package.unknownError')}</pre>,
        });
        return;
      }
      await alertDialog({
        title: t('topbar.package.done', { slug }),
        body: (
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>
            <div>{t('topbar.package.exportDir')}</div>
            <pre style={{ whiteSpace: 'pre-wrap', margin: '4px 0', fontSize: 12 }}>{j.outDir}</pre>
            <div>{t('topbar.package.runLocally')}</div>
            <pre style={{ whiteSpace: 'pre-wrap', margin: '4px 0', fontSize: 12 }}>{j.runHint}</pre>
            <div style={{ opacity: 0.7, marginTop: 8 }}>{t('topbar.package.webgpuHint')}</div>
          </div>
        ),
      });
    } catch (e) {
      await alertDialog({ title: t('topbar.package.failed'), body: String((e as Error)?.message ?? e) });
    } finally {
      setPackaging(false);
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
      <div className="tb-left">
        {/* Decorative macOS-style traffic dots are a WEB-form aesthetic. In the
           Tauri desktop app the OS draws the real (functional) traffic lights,
           so drawing our own here duplicates them — render only in the browser. */}
        {!isTauri() && (
          <>
            <div className="tb-dots-cluster">
              <span className="dot r" />
              <span className="dot y" />
              <span className="dot g" />
            </div>
            <TbDivider />
          </>
        )}
        {/* 2026-06-02 — removed the standalone "+" (NewMenu): its "新建 game" /
            "新建 session" duplicated the per-selector create actions. Each
            selector now owns its own pinned "新建 X": workspace → ProjectSwitcher,
            game → GameSwitcher, session → SessionSwitcher. */}
        <ProjectSwitcher />
        <TbDivider />
        <GameSwitcher />
        {/* Forge agent entry region — the SessionSwitcher drives chat-session
            picking for the Forge agent. Anchored with data-testid="forge-entry"
            (plan-strategy section 2 D-9: testid is the i18n / theme-stable
            selector). When hideChatAndForge=true the standalone editor host
            (packages/editor/standalone/) renders the App shell without this
            cluster. */}
        {!hideChatAndForge && (
          <span data-testid="forge-entry" style={{ display: 'contents' }}>
            <TbDivider />
            <SessionSwitcher />
          </span>
        )}
      </div>

      <WorkspaceTabs setMode={setMode} />

      <div className="tb-right">
        <DashboardToggle />
        <TbDivider />
        <button
          type="button"
          className="tb-icon-btn"
          title={t('topbar.layout.tooltip')}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            window.dispatchEvent(new CustomEvent(APP_EVENTS.dockLayoutToggle, {
              detail: { rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right } },
            }));
          }}
        >
          <LayoutGrid size={16} />
        </button>
        <TbDivider />
        <button
          type="button"
          className="tb-icon-btn"
          onClick={() => openSettings()}
          title={t('topbar.settings.tooltip')}
        >
          <Settings size={16} />
        </button>
        <TbDivider />
        <button
          type="button"
          className="tb-publish-btn"
          onClick={onPackageGame}
          disabled={packaging}
          title={packaging ? t('topbar.publish.packaging') : t('topbar.publish.tooltip')}
        >
          <Rocket size={16} />
        </button>
      </div>
    </div>
    <ConfirmToastList confirms={pendingConfirms} onAck={ack} onDeny={deny} />
    </>
  );
}

// GameSwitcher + NewGameModal + timeSince extracted → ./GameSwitcher (§D).

function DashboardToggle() {
  const dashboardOpen = useAppStore((s) => s.dashboardOpen);
  const setDashboardOpen = useAppStore((s) => s.setDashboardOpen);
  return (
    <button
      className={`tb-icon-btn${dashboardOpen ? ' active' : ''}`}
      onClick={() => setDashboardOpen(!dashboardOpen)}
      title="Dashboard — Run/Thread/Provider monitoring"
    >
      <CircleGauge size={16} />
    </button>
  );
}

