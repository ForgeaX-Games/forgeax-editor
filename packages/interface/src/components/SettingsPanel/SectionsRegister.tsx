/**
 * SectionsRegister — mounts once at App root, owns the shared settings state
 * (env data, providers, busy flag, test results, etc.) and registers ALL the
 * built-in sections into the settings-panel registry.
 *
 * Sections registered (in nav order):
 *   - Plugins      (group=plugin)    — BusAdminPanel (full bus inventory)
 *   - API Keys     (group=config)    — anthropic / openai / gemini + multimodal
 *                                       (ark / azure-gpt-image / kling / litellm)
 *   - Models       (group=config)    — FORGEAX_MODEL select
 *   - CLI Providers (group=config)   — health + 1-token Test
 *   - Workspace    (group=system)    — reset session + path display
 *   - Account      (group=account)   — Forge account (stub)
 *   - About        (group=about)     — paths + version
 *
 * Each section is a plain ReactNode — the registry just remembers them. The
 * SettingsPanel component reads from the registry, sorts by group+priority,
 * and renders the active one.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Command, Cpu, FlaskConical, GitFork, History, Info, Key, Network, Plug, RefreshCw, ShieldCheck, Sparkles, Trash2, User, Users } from 'lucide-react';
import { buildShortcuts, prettyCombo, type ShortcutDef } from '../../lib/global-shortcuts';
import { confirmDialog } from '../../lib/dialog';
import { Section, EnvField } from '../TopBar/SettingsDrawer';
import { BusAdminPanel } from '../Bus/BusAdminPanel';
import { useSettingsSection } from './store';
import { BootSplashSection } from '../../boot/SettingsSection';
import { ModelPicker } from '../ModelPicker';
import { TrustPanel } from './TrustPanel';
import { AuthorPanel } from './AuthorPanel';
import { useAppStore, seedUninstalledIfFirstRun } from '../../store';

// ── shared state types (kept in sync with /api/settings) ─────────────────

interface SettingsData {
  env: Record<string, string | null>;
  paths: { projectRoot: string; envPath: string };
}

interface ProviderRow {
  id: string;
  displayName: string;
  capabilities: Record<string, boolean>;
  health: { ok: boolean; detail?: string };
}

const MODEL_OPTIONS = [
  { value: 'claude-opus-4-7', label: 'Claude Opus 4.7 (current)' },
  { value: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
];

// Multimodal key envs that don't fit the original ANTHROPIC/OPENAI/GEMINI
// trio — surfaced now that wb-character and other multimodal plugins need
// them visible in the UI. SAFE_ENV_KEYS in api/settings.ts whitelists each of these.
const MULTIMODAL_KEYS: Array<{ key: string; label: string; placeholder: string; visible?: boolean }> = [
  { key: 'ARK_IMAGE_KEY',          label: 'ARK_IMAGE_KEY (Seedream 立绘)',          placeholder: 'volcengine ARK image key' },
  { key: 'ARK_VIDEO_KEY',          label: 'ARK_VIDEO_KEY (Seedance 视频)',          placeholder: 'volcengine ARK video key' },
  { key: 'AZURE_GPT_IMAGE_KEY',    label: 'AZURE_GPT_IMAGE_KEY (gpt-image-2)',      placeholder: 'azure cognitive services key' },
  { key: 'AZURE_GPT_IMAGE_ENDPOINT', label: 'AZURE_GPT_IMAGE_ENDPOINT',             placeholder: 'https://*-swedencentral.cognitiveservices.azure.com', visible: true },
  { key: 'AZURE_GPT_IMAGE_DEPLOYMENT', label: 'AZURE_GPT_IMAGE_DEPLOYMENT',         placeholder: 'gpt-image-2', visible: true },
  { key: 'LITELLM_PROXY_KEY',      label: 'LITELLM_PROXY_KEY',                      placeholder: 'sk-... (LiteLLM proxy)' },
  { key: 'LITELLM_PROXY_BASE_URL', label: 'LITELLM_PROXY_BASE_URL',                 placeholder: 'https://<your-proxy>/v1', visible: true },
];

export function SettingsSectionsRegister() {
  const [data, setData] = useState<SettingsData | null>(null);
  const [providers, setProviders] = useState<ProviderRow[] | null>(null);
  const [providersCachedAt, setProvidersCachedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [tests, setTests] = useState<Record<string, { status: 'running' | 'ok' | 'err'; totalMs?: number; ttftMs?: number; sawTool?: boolean; err?: string; ranAt?: number }>>({});
  const inFlightTests = useRef<Set<AbortController>>(new Set());

  useEffect(() => {
    return () => {
      for (const ac of inFlightTests.current) {
        try { ac.abort(); } catch { /* */ }
      }
      inFlightTests.current.clear();
    };
  }, []);

  const reload = async () => {
    try {
      const r = await fetch('/api/settings');
      setData((await r.json()) as SettingsData);
    } catch { /* */ }
  };
  const reloadInFlight = useRef<Promise<void> | null>(null);
  const reloadProviders = async (force = false) => {
    if (reloadInFlight.current) return reloadInFlight.current;
    const p = (async () => {
      try {
        const { fetchCliProviders } = await import('../../lib/cli-providers');
        const { providers, cachedAt } = await fetchCliProviders(force);
        setProviders(providers as unknown as ProviderRow[]);
        setProvidersCachedAt(cachedAt);
      } catch { /* */ }
    })();
    reloadInFlight.current = p;
    try { await p; } finally { reloadInFlight.current = null; }
  };
  useEffect(() => { void reload(); void reloadProviders(); }, []);

  const flash = (kind: 'ok' | 'err', text: string) => {
    setToast({ kind, text });
    setTimeout(() => setToast(null), 2500);
  };

  const patchEnv = async (patch: Record<string, string>) => {
    setBusy(true);
    try {
      const r = await fetch('/api/settings/env', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const j = (await r.json()) as { ok?: boolean; error?: string; touched?: number };
      if (!r.ok || !j.ok) flash('err', j.error ?? `HTTP ${r.status}`);
      else { flash('ok', `已写入 ${j.touched} 个变量到 .env（重启 stack 后生效）`); await reload(); }
    } catch (e) {
      flash('err', (e as Error).message);
    } finally { setBusy(false); }
  };

  const testProvider = async (id: string) => {
    setTests((t) => ({ ...t, [id]: { status: 'running' } }));
    const started = performance.now();
    let ttft: number | undefined;
    const ac = new AbortController();
    inFlightTests.current.add(ac);
    const timer = setTimeout(() => ac.abort(), 30_000);
    try {
      // R3 路径：原 `/api/chat` 已下线；走临时 cli-provider 桥（带
      // Deprecation header，最终被 commands.attach_script_agent 取代）。
      const res = await fetch('/api/cli/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: 'forgeax', message: 'respond with the single word: ok', providerOverride: id }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let errText: string | undefined;
      let sawTool = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        if (ttft === undefined && /event: token/.test(buf)) ttft = performance.now() - started;
        if (!sawTool && /event: tool-call/.test(buf)) sawTool = true;
        if (errText === undefined) {
          const errMatch = buf.match(/event: error[\s\S]*?\n\n/);
          if (errMatch) {
            const dat = errMatch[0].match(/data: (.+)/)?.[1];
            try { errText = JSON.parse(dat!).message; } catch { errText = dat; }
          }
        }
      }
      const total = performance.now() - started;
      const ranAt = Date.now();
      if (errText) setTests((t) => ({ ...t, [id]: { status: 'err', totalMs: total, err: errText, ranAt } }));
      else setTests((t) => ({ ...t, [id]: { status: 'ok', totalMs: total, ttftMs: ttft, sawTool, ranAt } }));
    } catch (e) {
      const errName = (e as Error).name;
      const errMsg = errName === 'AbortError' ? `timed out after 30s` : (e as Error).message;
      setTests((t) => ({ ...t, [id]: { status: 'err', err: errMsg, ranAt: Date.now() } }));
    } finally {
      clearTimeout(timer);
      inFlightTests.current.delete(ac);
    }
  };

  const resetSessions = async () => {
    if (!(await confirmDialog({ body: '确认清空所有 session（含 sub-agent 历史）?', danger: true }))) return;
    setBusy(true);
    try {
      const r = await fetch('/api/settings/reset-sessions', { method: 'POST' });
      // Server may answer with non-JSON (e.g. nginx 404 HTML, gateway timeout
      // text) — `.json()` would throw SyntaxError and the user sees noise like
      // "Unexpected token '<'" instead of the actual HTTP status.
      const j = (await r.json().catch(() => null)) as
        | { ok?: boolean; error?: string; removed?: number }
        | null;
      if (!r.ok || !j?.ok) {
        flash('err', j?.error ?? `HTTP ${r.status}${r.statusText ? ` ${r.statusText}` : ''}`);
      } else {
        flash('ok', `已删除 ${j.removed} 个 session 目录`);
      }
    } catch (e) {
      flash('err', (e as Error).message);
    } finally { setBusy(false); }
  };

  const envOf = (k: string): string | null => data?.env?.[k] ?? null;

  // ── Section nodes (memoized so registry doesn't churn) ───────────────────

  const pluginsNode = useMemo(() => (
    <div className="sp-section-fill">
      <BusAdminPanel />
    </div>
  ), []);

  const apiKeysNode = useMemo(() => {
    if (!data) return <div className="settings-loading">加载中…</div>;
    return (
      <>
        <Section icon={<Key size={14} />} title="LLM / CLI Keys" hint="forgeax/.env;重启 stack 后生效">
          <EnvField label="ANTHROPIC_API_KEY"  masked={envOf('ANTHROPIC_API_KEY')}  placeholder="sk-ant-... 或 Azure key" onSave={(v) => void patchEnv({ ANTHROPIC_API_KEY: v })} busy={busy} />
          <EnvField label="ANTHROPIC_BASE_URL" masked={envOf('ANTHROPIC_BASE_URL')} placeholder="https://api.anthropic.com" onSave={(v) => void patchEnv({ ANTHROPIC_BASE_URL: v })} busy={busy} visible />
          <EnvField label="OPENAI_API_KEY"     masked={envOf('OPENAI_API_KEY')}     placeholder="sk-..."                  onSave={(v) => void patchEnv({ OPENAI_API_KEY: v })} busy={busy} />
          <EnvField label="OPENAI_BASE_URL"    masked={envOf('OPENAI_BASE_URL')}    placeholder="https://api.openai.com"  onSave={(v) => void patchEnv({ OPENAI_BASE_URL: v })} busy={busy} visible />
          <EnvField label="GEMINI_API_KEY"     masked={envOf('GEMINI_API_KEY')}     placeholder="AIza..."                 onSave={(v) => void patchEnv({ GEMINI_API_KEY: v })} busy={busy} />
        </Section>

        <Section icon={<Key size={14} />} title="多模态 Keys" hint="image-gen / video-gen / 多模代理 · wb-character 等插件用">
          {MULTIMODAL_KEYS.map((k) => (
            <EnvField
              key={k.key}
              label={k.label}
              masked={envOf(k.key)}
              placeholder={k.placeholder}
              onSave={(v) => void patchEnv({ [k.key]: v })}
              busy={busy}
              visible={k.visible}
            />
          ))}
        </Section>
      </>
    );
  }, [data, busy]);

  const modelsNode = useMemo(() => {
    if (!data) return <div className="settings-loading">加载中…</div>;
    return (
      <Section icon={<Cpu size={14} />} title="模型" hint="改 FORGEAX_MODEL（重启 stack 后生效）">
        <div className="settings-row">
          <label className="settings-label">当前</label>
          <select
            className="settings-select"
            value={envOf('FORGEAX_MODEL') ?? ''}
            onChange={(e) => void patchEnv({ FORGEAX_MODEL: e.target.value })}
            disabled={busy}
          >
            {MODEL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="settings-help">
          所有 LLM 凭证从 <code>$ROOT/.env</code> 读取；按 model id 模式自动选 adapter
          （<code>claude-*</code> → Anthropic / <code>gpt-*</code> → OpenAI / <code>gemini-*</code> → Gemini /
          <code>deepseek-*</code> → DeepSeek）。配了 <code>LITELLM_PROXY_*</code> 时全部走代理。
        </div>
      </Section>
    );
  }, [data, busy]);

  const modelLabNode = useMemo(() => (
    <Section icon={<FlaskConical size={14} />} title="Model Lab" hint="一次性测模型 · 调温度 / top_p / max_tokens · 走 /api/llm/test → lib/llm-gateway → LiteLLM 代理">
      <ModelLabBody />
    </Section>
  ), []);

  const cliProvidersNode = useMemo(() => (
    <Section icon={<Plug size={14} />} title="CLI Providers" hint="多 cli 后端 — agent 由 marketplace/manifest.json#agents[].provider 路由">
      {!providers && <div className="settings-help">加载中…</div>}
      {providers && providers.length === 0 && (
        <div className="settings-help">无注册的 provider — 检查 server 启动日志。</div>
      )}
      {providers?.map((p) => {
        const caps = Object.entries(p.capabilities).filter(([, v]) => v).map(([k]) => k);
        const t = tests[p.id];
        return (
          <div key={p.id} className={`settings-provider-row ${!p.health.ok ? 'is-down' : ''}`}>
            <div className="settings-provider-head">
              <code className="settings-provider-id">{p.id}</code>
              <span className="settings-provider-name">{p.displayName}</span>
              <span className={p.health.ok ? 'ok-pill' : 'err-pill'}>
                {p.health.ok ? '健康 ✓' : '不可用 ✗'}
              </span>
            </div>
            {p.health.detail && (
              <div className="settings-help" title={p.health.detail}>{p.health.detail}</div>
            )}
            <div className="settings-provider-caps">
              {caps.map((c) => <span key={c} className="settings-cap-chip">{c}</span>)}
            </div>
            <div className="settings-provider-test">
              <button
                type="button"
                className="settings-edit-btn"
                onClick={() => void testProvider(p.id)}
                disabled={t?.status === 'running' || !p.health.ok}
              >
                {t?.status === 'running' ? '测试中…' : 'Test'}
              </button>
              {t && t.status !== 'running' && (
                <span className="settings-help" style={{ display: 'inline', marginLeft: 8 }}>
                  {t.status === 'ok'
                    ? t.ttftMs !== undefined
                      ? `✓ ttft ${Math.round(t.ttftMs)}ms · total ${Math.round(t.totalMs ?? 0)}ms`
                      : t.sawTool
                        ? `✓ done · ${Math.round(t.totalMs ?? 0)}ms (tool-only turn)`
                        : `✓ silent done · ${Math.round(t.totalMs ?? 0)}ms`
                    : `✗ ${t.err?.slice(0, 80) ?? 'failed'}`}
                </span>
              )}
            </div>
          </div>
        );
      })}
      <div style={{ display: 'flex', gap: 6, marginTop: 4, alignItems: 'center' }}>
        <button className="settings-edit-btn" onClick={() => void reloadProviders(true)} disabled={busy}>
          <RefreshCw size={11} /> 刷新
        </button>
        {providersCachedAt && (
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', marginLeft: 'auto' }}>
            快照 · {Math.round((Date.now() - providersCachedAt) / 1000)}s 前
          </span>
        )}
      </div>
    </Section>
  ), [providers, providersCachedAt, busy, tests]);

  const workspaceNode = useMemo(() => {
    if (!data) return <div className="settings-loading">加载中…</div>;
    return (
      <>
        <Section icon={<Trash2 size={14} />} title="重置 session" hint="清空 team/sessions/* — 保留 agent 配置 / marketplace / games">
          <button className="settings-danger-btn" onClick={() => void resetSessions()} disabled={busy}>
            <RefreshCw size={12} /> 清空所有 session 历史
          </button>
        </Section>
        <Section icon={<Info size={14} />} title="路径 / 端口" hint="只读">
          <div className="settings-info">
            <div><span className="dim">project root:</span> {data.paths.projectRoot}</div>
            <div><span className="dim">env file:</span> {data.paths.envPath}</div>
            <div><span className="dim">studio:</span> :18920 (UI) · :18900 (server) · :15173 (engine)</div>
          </div>
        </Section>
      </>
    );
  }, [data, busy]);

  const accountNode = useMemo(() => (
    <Section icon={<User size={14} />} title="账号" hint="云同步 / 订阅 / 分享设置 (规划中)">
      <div className="settings-info">
        <div className="dim">未登录</div>
        <div style={{ marginTop: 8 }}>
          云端账号体系尚在规划中。本地 forgeax-studio 完全离线可用,云端功能后续解锁:
        </div>
        <ul style={{ margin: '8px 0 0 20px', color: 'var(--text-dim)' }}>
          <li>多设备同步 game/agent</li>
          <li>云端 model gateway · 共享 LLM key 池</li>
          <li>订阅 · token 配额</li>
        </ul>
      </div>
    </Section>
  ), []);

  const aboutNode = useMemo(() => (
    <Section icon={<Info size={14} />} title="forgeax-studio" hint="版本 · 路径 · 链接">
      <AboutBody />
    </Section>
  ), []);

  const changelogNode = useMemo(() => (
    <Section icon={<History size={14} />} title="Changelog" hint="版本迭代记录 · 来源 CHANGELOG.md">
      <ChangelogBody />
    </Section>
  ), []);

  const shortcutsNode = useMemo(() => (
    <Section icon={<Command size={14} />} title="键盘快捷键" hint="只读 · 当前不可自定义">
      <ShortcutsBody />
    </Section>
  ), []);

  const usageNode = useMemo(() => (
    <Section icon={<Activity size={14} />} title="用量" hint="基于 ledger hook:assistantMessage 事件聚合 · 仅本机 sessions">
      <UsageBody />
    </Section>
  ), []);

  const agentsNode = useMemo(() => (
    <Section icon={<Users size={14} />} title="Agents" hint="勾掉的 agent 不在主 agent 头像行 / delegate 工具中显示">
      <AgentsBody />
    </Section>
  ), []);

  // ── Register sections ────────────────────────────────────────────────────

  useSettingsSection({ id: 'plugins',       label: 'Plugins',       priority: 95, group: 'plugin',  icon: Network, node: pluginsNode });
  useSettingsSection({ id: 'agents',        label: 'Agents',        priority: 94, group: 'plugin',  icon: Users, node: agentsNode });
  useSettingsSection({ id: 'fxpack',        label: '.fxpack 导入',  priority: 92, group: 'plugin',  icon: ShieldCheck, node: <TrustPanel /> });
  useSettingsSection({ id: 'author',        label: 'Fork & 录制',   priority: 91, group: 'plugin',  icon: GitFork, node: <AuthorPanel /> });
  useSettingsSection({ id: 'api-keys',      label: 'API Keys',      priority: 90, group: 'config',  icon: Key,     node: apiKeysNode });
  useSettingsSection({ id: 'models',        label: 'Models',        priority: 80, group: 'config',  icon: Cpu,     node: modelsNode });
  useSettingsSection({ id: 'model-lab',     label: 'Model Lab',     priority: 75, group: 'config',  icon: FlaskConical, node: modelLabNode });
  useSettingsSection({ id: 'cli-providers', label: 'CLI Providers', priority: 70, group: 'config',  icon: Plug,    node: cliProvidersNode });
  useSettingsSection({ id: 'usage',         label: '用量',          priority: 67, group: 'config',  icon: Activity, node: usageNode });
  useSettingsSection({ id: 'boot-splash',   label: 'Boot Splash',   priority: 65, group: 'system',  icon: Sparkles, node: <BootSplashSection /> });
  useSettingsSection({ id: 'shortcuts',     label: 'Shortcuts',     priority: 62, group: 'system',  icon: Command, node: shortcutsNode });
  useSettingsSection({ id: 'workspace',     label: 'Workspace',     priority: 60, group: 'system',  icon: Trash2,  node: workspaceNode });
  useSettingsSection({ id: 'account',       label: 'Account',       priority: 50, group: 'account', icon: User,    node: accountNode });
  useSettingsSection({ id: 'changelog',     label: 'Changelog',     priority: 45, group: 'about',   icon: History, node: changelogNode });
  useSettingsSection({ id: 'about',         label: 'About',         priority: 40, group: 'about',   icon: Info,    node: aboutNode });

  return toast ? (
    <div className={`settings-toast ${toast.kind}`} style={{ position: 'fixed', right: 24, bottom: 24, zIndex: 'var(--z-toast)' }}>
      {toast.text}
    </div>
  ) : null;
}

// ── About / Changelog · live data ────────────────────────────────────────
//
// AboutBody fetches /api/version on mount so the displayed version + sha +
// branch + date stay current with `git rev-list --count main`.  Falls back
// to env-derived values if the fetch fails (offline / server starting).

interface VersionInfo {
  version: string;
  sha: string;
  date: string;
  totalCommits: number;
  branch: string;
}

function AboutBody() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/version')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d) setInfo(d as VersionInfo); })
      .catch(() => { /* offline — fall back to "(connecting…)" */ });
    return () => { cancelled = true; };
  }, []);
  return (
    <div className="settings-info">
      <div>
        <span className="dim">version:</span>{' '}
        <code style={{ color: 'var(--primary)' }}>{info?.version ?? '(connecting…)'}</code>
      </div>
      <div>
        <span className="dim">commit:</span>{' '}
        <code>{info?.sha ?? '?'}</code> · {info?.date ?? '?'} · branch <code>{info?.branch ?? '?'}</code>
      </div>
      <div>
        <span className="dim">累计 commits:</span>{' '}
        <code>{info?.totalCommits ?? 0}</code> on <code>main</code>
      </div>
      <div style={{ marginTop: 6 }}>
        <span className="dim">repo:</span>{' '}
        <a href="https://github.com/ForgeaX-Games/forgeax-studio" target="_blank" rel="noreferrer">
          github.com/ForgeaX-Games/forgeax-studio
        </a>
      </div>
      <div style={{ color: 'var(--text-dim)', fontSize: 12, marginTop: 8, lineHeight: 1.6 }}>
        版本号方案 <code>v0.M.D.N</code> — 0 = pre-1.0 epoch · M.D = main 最新 commit 月.日 · N = main 累计 commit。
        详情见 <code>CHANGELOG.md</code> / <code>scripts/version.sh</code>。
      </div>
    </div>
  );
}

// ── Agents section body — fetches /api/workbench/agents and renders a list
//    with a checkbox per agent. Toggling drives store.toggleAgentInstalled,
//    which mirrors to localStorage + server-side prefs file.
//    Default = all installed; user opts agents *out*. Main agent (isMain)
//    is excluded from the toggle list — uninstalling it would break the
//    session bootstrap. We surface it as a read-only row.

interface WorkbenchAgent {
  id: string;
  name: string;
  role: string;
  color: string;
  avatar: string;
  status: 'active' | 'placeholder' | string;
  isMain: boolean;
}

function AgentsBody() {
  const [agents, setAgents] = useState<WorkbenchAgent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const uninstalledIds = useAppStore((s) => s.uninstalledAgentIds);
  const toggle = useAppStore((s) => s.toggleAgentInstalled);
  const defaultBootstrap = useAppStore((s) => s.defaultBootstrapAgent);
  const setDefaultBootstrap = useAppStore((s) => s.setDefaultBootstrapAgent);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/workbench/agents?lang=zh')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { agents: WorkbenchAgent[]; error?: string }) => {
        if (cancelled) return;
        if (d.error) setErr(d.error);
        const list = d.agents ?? [];
        const main = list.find((a) => a.isMain)?.id;
        seedUninstalledIfFirstRun(list.map((a) => a.id), main);
        setAgents(list);
      })
      .catch((e: unknown) => { if (!cancelled) setErr((e as Error).message); });
    return () => { cancelled = true; };
  }, []);

  if (err) return <div className="settings-info"><div style={{ color: 'var(--err)' }}>加载失败: {err}</div></div>;
  if (!agents) return <div className="settings-info dim">加载中…</div>;
  if (agents.length === 0) return <div className="settings-info dim">没有可管理的 agent。</div>;

  // 「主 agent」= 新 session 的入口 agent，单一概念。
  //   优先级：用户在下拉框里选的 (defaultBootstrap) → 退化到 manifest 标 isMain
  //   的那个 (forge) → 兜底 'root'。三者读出来的都是 agent id 字符串。
  // ChatAgentStrip / list 的"main"高亮 + 不可卸载语义都跟随这个 effective 值，
  // SSOT —— 不再维护 isMain 跟 defaultBootstrap 两份。
  const manifestMain = agents.find((a) => a.isMain);
  const effectiveMainId = defaultBootstrap ?? manifestMain?.id ?? null;
  const effectiveMain = effectiveMainId
    ? agents.find((a) => a.id === effectiveMainId) ?? null
    : null;

  // 候选 = 已安装的 + 当前 main 自己（保证 main 出现在选项里，即便用户把它当
  // 成已卸载也能在下拉框选回来）。
  const bootstrapCandidates = agents.filter(
    (a) => a.id === effectiveMainId || !uninstalledIds.includes(a.id),
  );

  // 列表渲染：所有 agent 同一档显示，main 那一项不显 checkbox / 显 badge。
  const sortedAgents = [...agents].sort((a, b) => {
    if (a.id === effectiveMainId) return -1;
    if (b.id === effectiveMainId) return 1;
    const aOff = uninstalledIds.includes(a.id) ? 1 : 0;
    const bOff = uninstalledIds.includes(b.id) ? 1 : 0;
    if (aOff !== bOff) return aOff - bOff;
    return a.id.localeCompare(b.id);
  });
  const installedCount = sortedAgents.filter(
    (a) => a.id !== effectiveMainId && !uninstalledIds.includes(a.id),
  ).length;
  const subCount = sortedAgents.filter((a) => a.id !== effectiveMainId).length;

  return (
    <div className="settings-info" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ color: 'var(--text-dim)', fontSize: 12, lineHeight: 1.6 }}>
        共 <code>{subCount}</code> 个 sub-agent · 已安装 <code>{installedCount}</code> ·
        卸载后将从主 agent 头像行 / delegate 工具列表中隐藏，session 树中已实例化的 agent 不受影响。
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'var(--surface-elevated)', borderRadius: 6 }}>
        <strong style={{ flexShrink: 0 }}>主 agent</strong>
        <span className="dim" style={{ fontSize: 11, flexShrink: 0 }}>新 session 入口</span>
        <select
          value={defaultBootstrap ?? ''}
          onChange={(e) => setDefaultBootstrap(e.target.value || null)}
          style={{ flex: 1, padding: '4px 8px', background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4 }}
        >
          <option value="">
            {manifestMain ? `跟随 manifest (${manifestMain.id})` : '跟随 manifest'}
          </option>
          {bootstrapCandidates.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.id}){a.isMain ? ' · manifest main' : ''}
            </option>
          ))}
        </select>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {sortedAgents.map((a) => {
          const isMain = a.id === effectiveMainId;
          const installed = isMain || !uninstalledIds.includes(a.id);
          return (
            <label
              key={a.id}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', borderRadius: 6, cursor: isMain ? 'default' : 'pointer', opacity: installed ? 1 : 0.55, background: isMain ? 'var(--surface-elevated)' : 'transparent' }}
              onMouseEnter={(e) => { if (!isMain) (e.currentTarget as HTMLElement).style.background = 'var(--surface-elevated)'; }}
              onMouseLeave={(e) => { if (!isMain) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              {isMain ? (
                <span style={{ width: 16, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }} aria-hidden>★</span>
              ) : (
                <input
                  type="checkbox"
                  checked={installed}
                  onChange={() => toggle(a.id)}
                  style={{ cursor: 'pointer' }}
                />
              )}
              <span style={{ width: 22, height: 22, borderRadius: 4, background: a.color, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, flexShrink: 0 }}>{a.avatar}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <strong>{a.name}</strong>
                  {isMain && <span className="dim" style={{ fontSize: 11, marginLeft: 6 }}>· main · 新 session 入口</span>}
                  {!isMain && a.status === 'placeholder' && <span className="dim" style={{ fontSize: 11, marginLeft: 6 }}>· placeholder</span>}
                </div>
                <div className="dim" style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.role}</div>
              </div>
              <code style={{ fontSize: 10, color: 'var(--text-dim)' }}>{a.id}</code>
            </label>
          );
        })}
      </div>
    </div>
  );
}

// ── Changelog section body — fetches /api/changelog and renders a vertical
//    timeline of (version, date, title, 代码增量, 主题, body) cards.
//    Body markdown is rendered via a small inline transformer (we only need
//    bullets + bold + inline code — no need to drag in a full md library).

interface ChangelogEntry {
  version: string;
  date: string;
  title: string;
  delta?: string;
  theme?: string;
  body: string;
}

function ChangelogBody() {
  const [entries, setEntries] = useState<ChangelogEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/changelog')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { entries: ChangelogEntry[]; error?: string }) => {
        if (cancelled) return;
        if (d.error) setErr(d.error);
        setEntries(d.entries ?? []);
      })
      .catch((e: Error) => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, []);
  if (entries === null && !err) {
    return <div className="settings-info"><div className="dim">loading…</div></div>;
  }
  if (err) {
    return <div className="settings-info"><div style={{ color: 'var(--accent-error)' }}>读取失败:{err}</div></div>;
  }
  if (entries && entries.length === 0) {
    return <div className="settings-info"><div className="dim">CHANGELOG.md 还没有版本段落。</div></div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxHeight: '70vh', overflowY: 'auto', paddingRight: 8 }}>
      {entries!.map((e) => (
        <article
          key={e.version}
          style={{
            background: 'var(--bg-2)',
            border: '1px solid var(--color-border-subtle)',
            borderRadius: 10,
            padding: '14px 16px',
            borderLeft: '3px solid var(--primary)',
          }}
        >
          <header style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
            <code style={{ color: 'var(--primary)', fontSize: 13, fontWeight: 600 }}>{e.version}</code>
            <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{e.date}</span>
            <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>· {e.title}</span>
          </header>
          {e.delta && (
            <div style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--text-dim)', marginBottom: 6 }}>
              <span style={{ color: 'var(--color-role-art)' }}>Δ</span> {e.delta}
            </div>
          )}
          {e.theme && (
            <div style={{ fontSize: 13, color: 'var(--text-primary)', marginBottom: 8, lineHeight: 1.55 }}>
              {e.theme}
            </div>
          )}
          <MdLite text={e.body} />
        </article>
      ))}
    </div>
  );
}

// Tiny markdown subset renderer — bullets (- ...), bold (**...**), inline
// `code`, sub-section H3s (### ...). Anything else passes through as plain
// text. We don't pull in a full md library because the changelog body is
// hand-written by the same author who writes the rendering rules.
function MdLite({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  let bulletBuf: string[] = [];
  const flushBullets = (key: number) => {
    if (bulletBuf.length === 0) return;
    blocks.push(
      <ul key={`ul-${key}`} style={{ margin: '4px 0 8px 18px', padding: 0, color: 'var(--text-primary)' }}>
        {bulletBuf.map((b, i) => (
          <li key={i} style={{ marginBottom: 4, fontSize: 13, lineHeight: 1.6 }}>{renderInline(b)}</li>
        ))}
      </ul>,
    );
    bulletBuf = [];
  };
  text.split('\n').forEach((line, i) => {
    const bullet = /^\s*-\s+(.+)$/.exec(line);
    if (bullet) { bulletBuf.push(bullet[1]); return; }
    flushBullets(i);
    const h3 = /^###\s+(.+)$/.exec(line);
    if (h3) {
      blocks.push(
        <h4 key={`h-${i}`} style={{ margin: '10px 0 6px', fontSize: 13, color: 'var(--accent-violet-light)', fontWeight: 600, letterSpacing: '0.02em' }}>
          {renderInline(h3[1])}
        </h4>,
      );
      return;
    }
    if (line.trim() === '') return;
    if (line.startsWith('> ')) {
      blocks.push(
        <blockquote key={`q-${i}`} style={{ margin: '6px 0', padding: '6px 10px', borderLeft: '2px solid var(--color-border-subtle)', color: 'var(--text-dim)', fontSize: 12.5, lineHeight: 1.55 }}>
          {renderInline(line.slice(2))}
        </blockquote>,
      );
      return;
    }
    blocks.push(
      <p key={`p-${i}`} style={{ margin: '6px 0', fontSize: 13, lineHeight: 1.6 }}>{renderInline(line)}</p>,
    );
  });
  flushBullets(99999);
  return <>{blocks}</>;
}

// ── Shortcuts (read-only) ────────────────────────────────────────────────
//
// Lists the static keymap defined in lib/global-shortcuts.ts. Users cannot
// rebind yet — this section is informational. A future iteration will turn
// each row into an editable combo, persist overrides to localStorage, and
// reflect them in `buildShortcuts()` via a registry merge.

const GROUP_LABEL: Record<ShortcutDef['group'], string> = {
  layout:  '布局',
  mode:    '顶部模式',
  overlay: '浮层',
  focus:   '聚焦',
  general: '通用',
};

const GROUP_ORDER: Array<ShortcutDef['group']> = ['layout', 'overlay', 'mode', 'focus', 'general'];

function ShortcutsBody() {
  const shortcuts = useMemo(() => buildShortcuts(), []);
  const grouped = useMemo(() => {
    const out = new Map<ShortcutDef['group'], ShortcutDef[]>();
    for (const s of shortcuts) {
      if (!out.has(s.group)) out.set(s.group, []);
      out.get(s.group)!.push(s);
    }
    return out;
  }, [shortcuts]);

  return (
    <div className="settings-info" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ color: 'var(--text-dim)', fontSize: 12.5, lineHeight: 1.6 }}>
        Blender 风的 <strong>Ctrl+Shift+...</strong> 组合 — 避开浏览器 Ctrl+1/2/3 切 tab / Ctrl+J 下载 / Ctrl+B 收藏栏。
        <br />
        <strong>中文输入法安全</strong>:组词状态(<code>isComposing</code>)或 keyCode 229 自动跳过;聚焦在 input/textarea/可编辑元素上时也不触发(Esc / Ctrl+/ 是例外)。
        <br />
        当前为<strong>只读</strong>展示,后续会开放自定义。
      </div>

      {GROUP_ORDER.map((g) => {
        const list = grouped.get(g);
        if (!list || list.length === 0) return null;
        return (
          <div key={g}>
            <div style={{
              fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase',
              color: 'var(--accent-violet-light)', marginBottom: 6, fontWeight: 600,
            }}>
              {GROUP_LABEL[g]}
            </div>
            <table style={{
              width: '100%', borderCollapse: 'collapse', fontSize: 13,
            }}>
              <tbody>
                {list.map((s) => (
                  <tr key={s.combo} style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
                    <td style={{ padding: '7px 0 7px 0', width: 150, verticalAlign: 'middle' }}>
                      <ComboBadge combo={s.combo} />
                    </td>
                    <td style={{ padding: '7px 8px', color: 'var(--text-primary)', lineHeight: 1.5 }}>
                      {s.label}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

function ComboBadge({ combo }: { combo: string }) {
  // Split on "+" but keep Ctrl/Shift/Alt as separate keycap renderings.
  const parts = combo.split('+');
  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
      {parts.map((p, i) => (
        <kbd
          key={`${p}-${i}`}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            padding: '2px 7px',
            borderRadius: 5,
            border: '1px solid var(--color-border-subtle)',
            borderBottomWidth: 2,
            background: 'var(--color-background-floating)',
            color: 'var(--primary)',
            minWidth: 14,
            textAlign: 'center',
            lineHeight: 1.3,
          }}
          title={`pretty: ${prettyCombo(combo)}`}
        >
          {p}
        </kbd>
      ))}
    </span>
  );
}

function renderInline(s: string): React.ReactNode {
  // Replace **bold** and `code` — process serially in one pass.
  const parts: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < s.length) {
    // Bold (**...**)
    if (s.startsWith('**', i)) {
      const end = s.indexOf('**', i + 2);
      if (end !== -1) {
        parts.push(<strong key={`b${key++}`} style={{ color: 'var(--text-primary)' }}>{s.slice(i + 2, end)}</strong>);
        i = end + 2;
        continue;
      }
    }
    // Inline code (`...`)
    if (s[i] === '`') {
      const end = s.indexOf('`', i + 1);
      if (end !== -1) {
        parts.push(
          <code
            key={`c${key++}`}
            style={{ fontFamily: 'var(--font-mono)', background: 'var(--color-background-floating)', padding: '0 4px', borderRadius: 3, fontSize: '0.92em', color: 'var(--primary)', border: '1px solid var(--color-border-subtle)' }}
          >
            {s.slice(i + 1, end)}
          </code>,
        );
        i = end + 1;
        continue;
      }
    }
    // Plain run — take until the NEXT `**` or backtick after the current
    // char. Searching from `i+1` (not `i`) is what guarantees forward
    // progress: when `**` or a backtick at position `i` has no closing
    // partner, both branches above fall through to here. If we searched
    // from `i` the marker at `i` would match itself, end===i, slice empty,
    // i unchanged → infinite loop and the whole tab freezes (CHANGELOG.md
    // triple-backtick ``` blockquote lines used to trigger exactly that).
    const a = s.indexOf('**', i + 1);
    const b = s.indexOf('`', i + 1);
    const next = a === -1 ? b : b === -1 ? a : Math.min(a, b);
    const end = next === -1 ? s.length : next;
    parts.push(s.slice(i, end));
    i = end;
  }
  return parts;
}

// ── Model Lab — batch parallel test → table render ───────────────────────────
//
// 2026-05-21 rewrite: pick N models via <ModelPicker mode="multi">, fire each
// against /api/llm/test-stream (SSE) in parallel via Promise.allSettled, and
// render a sortable table with TTFT / total / tok/s / token counts per row.
//   - "Hide unavailable" filters rows where status==='fail'
//   - "Run failed" reruns just the fail subset
//   - "Export CSV" dumps the current results to clipboard
//
// Per-row state machine: queued → running → streaming → ok | fail
//   TTFT  = (first SSE `chunk` event ts) - startedAt
//   total = (done|error event ts) - startedAt
//   tok/s = completionTokens / max(1, total - ttft) * 1000

type RowStatus = 'idle' | 'queued' | 'running' | 'streaming' | 'ok' | 'fail';

interface RowResult {
  model: string;
  status: RowStatus;
  ttftMs?: number;
  totalMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  transport?: string;
  upstreamModel?: string;
  text?: string;
  error?: string;
}

// MAX_CONCURRENCY caps how many models hit LiteLLM at once. 16 is a soft cap
// chosen because LiteLLM's upstream rate limits (Anthropic 50/min, OpenAI tier
// 1 60/min) start punishing above this band and the per-stream socket cost on
// the studio host grows. Selecting more than this still works — extra rows
// queue and start as earlier ones finish.
const MAX_CONCURRENCY = 16;

function ModelLabBody() {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [prompt, setPrompt] = useState<string>('respond with the single word: ok');
  const [system, setSystem] = useState<string>('');
  const [temperature, setTemperature] = useState<number>(0.7);
  const [tempOn, setTempOn] = useState<boolean>(true);
  const [topP, setTopP] = useState<number>(1.0);
  const [topPOn, setTopPOn] = useState<boolean>(false);
  const [maxTokens, setMaxTokens] = useState<number>(64);
  const [maxTokensOn, setMaxTokensOn] = useState<boolean>(true);
  const [hideUnavailable, setHideUnavailable] = useState<boolean>(false);
  const [rows, setRows] = useState<Map<string, RowResult>>(new Map());
  const [running, setRunning] = useState(false);
  const abortRefs = useRef<Map<string, AbortController>>(new Map());

  // Tear down all in-flight aborts on unmount.
  useEffect(() => () => {
    for (const ac of abortRefs.current.values()) ac.abort();
    abortRefs.current.clear();
  }, []);

  const updateRow = (model: string, patch: Partial<RowResult>) => {
    setRows((prev) => {
      const next = new Map(prev);
      const cur = next.get(model) ?? { model, status: 'idle' as RowStatus };
      next.set(model, { ...cur, ...patch });
      return next;
    });
  };

  const runOne = async (model: string) => {
    const ac = new AbortController();
    abortRefs.current.set(model, ac);
    updateRow(model, { status: 'running', error: undefined, text: undefined, ttftMs: undefined, totalMs: undefined });
    try {
      const resp = await fetch('/api/llm/test-stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          system: system.trim() || undefined,
          temperature: tempOn ? temperature : undefined,
          topP: topPOn ? topP : undefined,
          maxTokens: maxTokensOn ? maxTokens : undefined,
        }),
        signal: ac.signal,
      });
      if (!resp.ok || !resp.body) {
        updateRow(model, { status: 'fail', error: `HTTP ${resp.status}` });
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let accText = '';
      let eventName: string | null = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          eventName = null;
          let dataStr = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
          }
          if (!eventName || !dataStr) continue;
          try {
            const data = JSON.parse(dataStr);
            if (eventName === 'meta') {
              updateRow(model, { status: 'streaming', transport: data.transport, upstreamModel: data.upstreamModel });
            } else if (eventName === 'chunk') {
              if (typeof data.delta === 'string') accText += data.delta;
              updateRow(model, { status: 'streaming', text: accText });
            } else if (eventName === 'done') {
              updateRow(model, {
                status: 'ok',
                ttftMs: data.ttftMs ?? undefined,
                totalMs: data.totalMs,
                transport: data.transport,
                upstreamModel: data.upstreamModel,
                promptTokens: data.usage?.promptTokens,
                completionTokens: data.usage?.completionTokens,
                totalTokens: data.usage?.totalTokens,
                text: accText,
              });
            } else if (eventName === 'error') {
              updateRow(model, {
                status: 'fail',
                error: data.error ?? 'unknown error',
                ttftMs: data.ttftMs ?? undefined,
                totalMs: data.totalMs,
              });
            }
          } catch { /* ignore malformed frame */ }
        }
      }
    } catch (e) {
      const name = (e as Error).name;
      updateRow(model, {
        status: 'fail',
        error: name === 'AbortError' ? 'aborted' : (e as Error).message,
      });
    } finally {
      abortRefs.current.delete(model);
    }
  };

  // Queue with concurrency cap. Promise.allSettled waits for everyone before
  // we flip running=false so the toolbar buttons re-enable cleanly.
  const runMany = async (modelIds: string[]) => {
    if (modelIds.length === 0) return;
    setRunning(true);
    // Seed all rows as queued so the table immediately shows the lineup.
    setRows((prev) => {
      const next = new Map(prev);
      for (const m of modelIds) next.set(m, { model: m, status: 'queued' });
      return next;
    });
    let cursor = 0;
    const workers: Array<Promise<void>> = [];
    const worker = async () => {
      while (cursor < modelIds.length) {
        const idx = cursor++;
        await runOne(modelIds[idx]);
      }
    };
    const n = Math.min(MAX_CONCURRENCY, modelIds.length);
    for (let i = 0; i < n; i++) workers.push(worker());
    await Promise.allSettled(workers);
    setRunning(false);
  };

  const runAll = () => void runMany(Array.from(selected));
  const runFailed = () => {
    const ids = Array.from(rows.values()).filter((r) => r.status === 'fail').map((r) => r.model);
    void runMany(ids);
  };
  const cancelAll = () => {
    for (const ac of abortRefs.current.values()) ac.abort();
  };

  const exportCsv = () => {
    const header = ['model', 'status', 'ttft_ms', 'total_ms', 'tok_per_s', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'transport', 'upstream', 'error', 'text'];
    const lines: string[] = [header.join(',')];
    for (const r of rows.values()) {
      const tps = (r.completionTokens && r.totalMs && r.ttftMs !== undefined)
        ? Math.round(r.completionTokens / Math.max(1, r.totalMs - r.ttftMs) * 1000)
        : '';
      const cells = [
        r.model,
        r.status,
        r.ttftMs ?? '',
        r.totalMs ?? '',
        tps,
        r.promptTokens ?? '',
        r.completionTokens ?? '',
        r.totalTokens ?? '',
        r.transport ?? '',
        r.upstreamModel ?? '',
        (r.error ?? '').replace(/[\r\n,"]/g, ' '),
        (r.text ?? '').replace(/[\r\n,"]/g, ' ').slice(0, 200),
      ];
      lines.push(cells.join(','));
    }
    const csv = lines.join('\n');
    void navigator.clipboard?.writeText(csv).catch(() => { /* fallback below */ });
    // Always also surface via download so non-clipboard browsers / iframes still get it.
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `model-lab-${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  };

  const visibleRows = useMemo(() => {
    const arr = Array.from(rows.values());
    return hideUnavailable ? arr.filter((r) => r.status !== 'fail') : arr;
  }, [rows, hideUnavailable]);

  const failCount = useMemo(
    () => Array.from(rows.values()).filter((r) => r.status === 'fail').length,
    [rows],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <label className="settings-label" style={{ display: 'block', marginBottom: 4 }}>Prompt</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={2}
          disabled={running}
          data-testid="model-lab-prompt"
          style={{
            width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12.5,
            padding: '8px 10px', borderRadius: 6,
            background: 'var(--bg-2)', border: '1px solid var(--border)',
            color: 'var(--text-primary)', resize: 'vertical',
          }}
        />
      </div>

      <details>
        <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-dim)' }}>
          System prompt (可选)
        </summary>
        <textarea
          value={system}
          onChange={(e) => setSystem(e.target.value)}
          rows={2}
          disabled={running}
          placeholder="e.g. You are a concise assistant."
          style={{
            width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12.5,
            padding: '8px 10px', marginTop: 6, borderRadius: 6,
            background: 'var(--bg-2)', border: '1px solid var(--border)',
            color: 'var(--text-primary)', resize: 'vertical',
          }}
        />
      </details>

      <SliderRow label="temperature" value={temperature} min={0} max={2} step={0.05}
        onChange={setTemperature} enabled={tempOn} onToggle={setTempOn}
        disabled={running} testId="model-lab-temp" />
      <SliderRow label="top_p" value={topP} min={0} max={1} step={0.05}
        onChange={setTopP} enabled={topPOn} onToggle={setTopPOn}
        disabled={running} testId="model-lab-top-p" />
      <SliderRow label="max_tokens" value={maxTokens} min={16} max={4096} step={16}
        onChange={setMaxTokens} enabled={maxTokensOn} onToggle={setMaxTokensOn}
        disabled={running} testId="model-lab-max-tokens"
        formatter={(v) => String(Math.round(v))} />

      <div>
        <label className="settings-label" style={{ display: 'block', marginBottom: 4 }}>
          Models — 勾选要并行测试的模型(已选 {selected.size})
        </label>
        <ModelPicker
          mode="multi"
          variant="inline"
          value={selected}
          onChange={(next) => {
            if (next instanceof Set) setSelected(next);
          }}
        />
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          className="settings-edit-btn"
          onClick={runAll}
          disabled={running || selected.size === 0 || !prompt.trim()}
          data-testid="model-lab-run-all"
        >
          {running ? `运行中… (${rows.size} rows)` : `Run all (${selected.size})`}
        </button>
        <button
          type="button"
          className="settings-edit-btn"
          onClick={runFailed}
          disabled={running || failCount === 0}
          data-testid="model-lab-run-failed"
          title={failCount === 0 ? 'no failed rows' : `rerun ${failCount} failed rows`}
        >
          Run failed ({failCount})
        </button>
        {running && (
          <button
            type="button"
            className="settings-edit-btn"
            onClick={cancelAll}
          >
            中止全部
          </button>
        )}
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text-dim)' }}>
          <input
            type="checkbox"
            checked={hideUnavailable}
            onChange={(e) => setHideUnavailable(e.target.checked)}
          />
          隐藏不可用
        </label>
        <button
          type="button"
          className="settings-edit-btn"
          onClick={exportCsv}
          disabled={rows.size === 0}
          title="导出当前结果为 CSV(同时写到剪贴板)"
        >
          Export CSV
        </button>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-dim)' }}>
          /api/llm/test-stream (SSE · TTFT 取首个 chunk)
        </span>
      </div>

      {visibleRows.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-dim)', padding: '8px 0' }}>
          {rows.size === 0 ? '勾选模型后点 "Run all"。' : '所有 row 已被 "隐藏不可用" 过滤。'}
        </div>
      ) : (
        <div
          data-testid="model-lab-table"
          style={{
            border: '1px solid var(--border)',
            borderRadius: 6,
            overflow: 'auto',
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
          }}
        >
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--bg-2)', textAlign: 'left' }}>
                <th style={{ padding: '6px 8px' }}>Model</th>
                <th style={{ padding: '6px 8px' }}>Status</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>TTFT</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>Total</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>tok/s</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>in/out/total</th>
                <th style={{ padding: '6px 8px' }}>Detail</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((r) => {
                const tps = (r.completionTokens && r.totalMs && r.ttftMs !== undefined)
                  ? Math.round(r.completionTokens / Math.max(1, r.totalMs - r.ttftMs) * 1000)
                  : null;
                return (
                  <tr key={r.model} data-testid={`model-lab-row-${r.model}`} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '6px 8px' }}>
                      {r.model}
                      {r.upstreamModel && r.upstreamModel !== r.model && (
                        <span style={{ color: 'var(--text-dim)' }}> → {r.upstreamModel}</span>
                      )}
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      <StatusPill status={r.status} />
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                      {r.ttftMs !== undefined ? `${r.ttftMs}ms` : '—'}
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                      {r.totalMs !== undefined ? `${r.totalMs}ms` : '—'}
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                      {tps !== null ? tps : '—'}
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', color: 'var(--text-dim)' }}>
                      {r.promptTokens ?? '—'}/{r.completionTokens ?? '—'}/{r.totalTokens ?? '—'}
                    </td>
                    <td style={{ padding: '6px 8px', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      title={r.error ?? r.text ?? ''}
                    >
                      {r.status === 'fail'
                        ? <span style={{ color: 'var(--accent-error, #ef4444)' }}>{r.error}</span>
                        : (r.text ?? '')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: RowStatus }) {
  const map: Record<RowStatus, { label: string; color: string }> = {
    idle:      { label: '—',         color: 'var(--text-dim)' },
    queued:    { label: 'queued',    color: 'var(--text-dim)' },
    running:   { label: 'running…',  color: 'var(--primary)' },
    streaming: { label: 'streaming', color: 'var(--primary)' },
    ok:        { label: '✓ ok',      color: 'var(--accent-success, #22c55e)' },
    fail:      { label: '✗ fail',    color: 'var(--accent-error, #ef4444)' },
  };
  const m = map[status];
  return <span style={{ color: m.color, fontWeight: 500 }}>{m.label}</span>;
}

function SliderRow({
  label, value, min, max, step, onChange, enabled, onToggle, disabled, testId, formatter,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  disabled?: boolean;
  testId?: string;
  formatter?: (v: number) => string;
}) {
  const display = formatter ? formatter(value) : value.toFixed(2);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, opacity: enabled ? 1 : 0.55 }}>
      <input
        type="checkbox"
        checked={enabled}
        disabled={disabled}
        onChange={(e) => onToggle(e.target.checked)}
        title={`include ${label} in request`}
        data-testid={testId ? `${testId}-toggle` : undefined}
        style={{ cursor: disabled ? 'default' : 'pointer' }}
      />
      <label className="settings-label" style={{ width: 96, fontFamily: 'var(--font-mono)', fontSize: 12 }}>
        {label}
      </label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled || !enabled}
        onChange={(e) => onChange(Number(e.target.value))}
        data-testid={testId}
        style={{ flex: 1 }}
      />
      <code style={{ width: 56, textAlign: 'right', fontSize: 12, color: enabled ? 'var(--primary)' : 'var(--text-dim)' }}>
        {enabled ? display : '—'}
      </code>
    </div>
  );
}

// ── Usage dashboard ──────────────────────────────────────────────────────
//
// 拉 /api/usage（Phase C7），把 totals + by-model + by-day 三块画成最简表格。
// 没有花哨图表 —— 这是 settings 子页面，先给数字 + 占比条；要图后面再说。

interface UsageRow { calls: number; inputTokens: number; outputTokens: number }
interface UsageReport {
  totals: UsageRow;
  byModel: Array<UsageRow & { model: string }>;
  bySession: Array<UsageRow & { sid: string }>;
  byDay: Array<UsageRow & { day: string }>;
  sourcedFrom: { sessionsScanned: number; eventsScanned: number };
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function UsageBody() {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setReport(null);
    setErr(null);
    fetch('/api/usage')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: UsageReport) => { if (!cancelled) setReport(d); })
      .catch((e: Error) => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, [reloadTick]);

  if (err) return <div className="settings-info"><div style={{ color: 'var(--accent-error)' }}>读取失败:{err}</div></div>;
  if (!report) return <div className="settings-info"><div className="dim">loading…</div></div>;

  const { totals, byModel, byDay, sourcedFrom } = report;
  const maxTokens = Math.max(1, ...byModel.map((m) => m.inputTokens + m.outputTokens));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
        <Stat label="总调用" value={fmtNum(totals.calls)} />
        <Stat label="input tokens" value={fmtNum(totals.inputTokens)} />
        <Stat label="output tokens" value={fmtNum(totals.outputTokens)} />
        <Stat label="sessions" value={String(sourcedFrom.sessionsScanned)} />
      </div>

      <button
        type="button"
        onClick={() => setReloadTick((x) => x + 1)}
        className="settings-secondary-btn"
        style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 6 }}
      >
        <RefreshCw size={12} /> 刷新
      </button>

      <div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 6 }}>按模型</div>
        {byModel.length === 0 ? (
          <div className="dim" style={{ fontSize: 12 }}>暂无 usage 数据 — assistant 还没回过任何 token。</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {byModel.map((row) => {
              const total = row.inputTokens + row.outputTokens;
              const pct = (total / maxTokens) * 100;
              return (
                <div key={row.model} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: 13 }}>{row.model}</div>
                    <div style={{ background: 'var(--bg-2)', borderRadius: 3, height: 6, overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: 'var(--primary)' }} />
                    </div>
                  </div>
                  <code style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                    {row.calls}× · in {fmtNum(row.inputTokens)} · out {fmtNum(row.outputTokens)}
                  </code>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 6 }}>按日期 (UTC)</div>
        {byDay.length === 0 ? (
          <div className="dim" style={{ fontSize: 12 }}>—</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {byDay.slice(-14).map((row) => (
              <div key={row.day} style={{ display: 'grid', gridTemplateColumns: '110px 1fr auto', gap: 10, alignItems: 'center', fontSize: 12 }}>
                <code style={{ color: 'var(--text-dim)' }}>{row.day}</code>
                <span>{row.calls} call · in {fmtNum(row.inputTokens)} · out {fmtNum(row.outputTokens)}</span>
                <span className="dim" />
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="dim" style={{ fontSize: 11 }}>
        scanned {sourcedFrom.eventsScanned} ledger events across {sourcedFrom.sessionsScanned} sessions.
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ minWidth: 88 }}>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: 18, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{value}</div>
    </div>
  );
}
