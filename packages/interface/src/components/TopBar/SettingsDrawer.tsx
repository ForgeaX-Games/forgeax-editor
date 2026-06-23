import { useEffect, useRef, useState } from 'react';
import { X, Key, Cpu, Trash2, RefreshCw, Info, Plug, Eye, EyeOff } from 'lucide-react';
import { confirmDialog } from '@/lib/dialog';

interface SettingsData {
  env: {
    ANTHROPIC_API_KEY: string | null;
    ANTHROPIC_BASE_URL: string | null;
    FORGEAX_MODEL: string | null;
    OPENAI_API_KEY: string | null;
    OPENAI_BASE_URL: string | null;
    GEMINI_API_KEY: string | null;
  };
  paths: { projectRoot: string; envPath: string };
}

interface ProviderRow {
  id: string;
  displayName: string;
  capabilities: {
    streaming: boolean;
    thinking: boolean;
    toolCalls: boolean;
    subAgents: boolean;
    sessions: boolean;
    jsonlReplay: boolean;
  };
  health: { ok: boolean; detail?: string };
}

const MODEL_OPTIONS = [
  { value: 'claude-opus-4-7', label: 'Claude Opus 4.7 (current)' },
  { value: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
];

export function SettingsDrawer({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<SettingsData | null>(null);
  const [providers, setProviders] = useState<ProviderRow[] | null>(null);
  const [providersCachedAt, setProvidersCachedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  // Per-provider Test button — keyed by provider id, holds latest run result.
  // status: 'idle' | 'running' | 'ok' | 'err'; ttftMs = time-to-first-token.
  // ranAt: Date.now() of completion, used to show 'just now' / 'Ns ago' below the result.
  // sawTool: true when the run streamed tool-call event(s) without any tokens
  // — distinguishes "tool-only turn" from genuinely "silent" (no work at all),
  // mirroring server-side sawWork (tick 288). Without this the forgeax path,
  // which often resolves trivial prompts via tool calls only, falsely
  // displayed as "silent done · no token events" — alarming but wrong.
  const [tests, setTests] = useState<Record<string, { status: 'running' | 'ok' | 'err'; totalMs?: number; ttftMs?: number; sawTool?: boolean; err?: string; ranAt?: number }>>({});
  // In-flight Test AbortControllers — aborted on drawer unmount so closing
  // mid-test stops the wasted fetch + server-side subprocess. Tied to a
  // ref so the cleanup effect sees the latest set.
  const inFlightTests = useRef<Set<AbortController>>(new Set());
  useEffect(() => {
    return () => {
      for (const ac of inFlightTests.current) {
        try { ac.abort(); } catch { /* ignore */ }
      }
      inFlightTests.current.clear();
    };
  }, []);
  // Tick once per second so 'ranAt' relative-time labels update without manual refresh.
  const [nowTick, setNowTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setNowTick((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, []);
  // Format Ns / Nm relative time. Single-line, monotonic.
  const relTime = (at: number | undefined): string => {
    if (!at) return '';
    // `void nowTick` participates in the closure read-set so the lint/compiler
    // and React reconciler both treat the string as nowTick-dependent — that
    // makes the per-second setNowTick tick (line 67) re-derive this value and
    // re-render the chip even though Date.now() isn't itself reactive.
    void nowTick;
    const s = Math.max(0, Math.round((Date.now() - at) / 1000));
    // Chinese-default UI — keep the freshness chip consistent with the
    // surrounding "刷新 / 多 cli 后端 / 关于" copy. The Test-result chip below
    // each provider stays English ("✓ ttft Nms · total Nms") since those are
    // technical metrics units that read fine either language.
    if (s < 5) return '刚刚';
    if (s < 60) return `${s} 秒前`;
    const m = Math.floor(s / 60);
    return `${m} 分钟前`;
  };

  const reload = async () => {
    try {
      const r = await fetch('/api/settings');
      setData((await r.json()) as SettingsData);
    } catch { /* ignore */ }
  };
  // Coalesce rapid 刷新 clicks: if a probe is already in flight, additional
  // calls await the same Promise instead of spawning a fresh `?force=1` HTTP
  // round-trip (tick 257 found 5 clicks → 5 subprocess pairs because the
  // server-side coalesce window doesn't catch serial requests). Cheap UX —
  // user sees the result on first click anyway.
  const reloadInFlight = useRef<Promise<void> | null>(null);
  const reloadProviders = async (force = false) => {
    if (reloadInFlight.current) return reloadInFlight.current;
    const p = (async () => {
      try {
        const { fetchCliProviders } = await import('../../lib/cli-providers');
        const { providers, cachedAt } = await fetchCliProviders(force);
        setProviders(providers as unknown as ProviderRow[]);
        setProvidersCachedAt(cachedAt);
      } catch { /* ignore */ }
    })();
    reloadInFlight.current = p;
    try { await p; } finally { reloadInFlight.current = null; }
  };
  useEffect(() => { reload(); reloadProviders(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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
      if (!r.ok || !j.ok) {
        flash('err', j.error ?? `HTTP ${r.status}`);
      } else {
        flash('ok', `已写入 ${j.touched} 个变量到 .env（重启 stack 后生效）`);
        await reload();
      }
    } catch (e) {
      flash('err', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Fire a 1-token POST /api/cli/chat to the named provider; measure ttft + total.
  // R3 路径：原 `/api/chat` 已下线；benchmark 走临时 cli-provider 桥（带
  // Deprecation header，最终被 commands.attach_script_agent 取代）。
  const TEST_TIMEOUT_MS = 30_000;
  const testProvider = async (id: string) => {
    setTests((t) => ({ ...t, [id]: { status: 'running' } }));
    const started = performance.now();
    let ttft: number | undefined;
    const ac = new AbortController();
    inFlightTests.current.add(ac);
    const timer = setTimeout(() => ac.abort(), TEST_TIMEOUT_MS);
    try {
      const res = await fetch('/api/cli/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agentId: 'forgeax',
          message: 'respond with the single word: ok',
          providerOverride: id,
        }),
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
        // Skip the error-frame scan once captured — the SSE buffer only
        // grows, so re-running the regex on every chunk produced the same
        // match and reparsed the same JSON. First-match-wins is the actual
        // semantic anyway (subsequent error frames are ignored).
        if (errText === undefined) {
          const errMatch = buf.match(/event: error[\s\S]*?\n\n/);
          if (errMatch) {
            const data = errMatch[0].match(/data: (.+)/)?.[1];
            try { errText = JSON.parse(data!).message; } catch { errText = data; }
          }
        }
      }
      const total = performance.now() - started;
      const ranAt = Date.now();
      if (errText) setTests((t) => ({ ...t, [id]: { status: 'err', totalMs: total, err: errText, ranAt } }));
      else setTests((t) => ({ ...t, [id]: { status: 'ok', totalMs: total, ttftMs: ttft, sawTool, ranAt } }));
    } catch (e) {
      const errName = (e as Error).name;
      const errMsg = errName === 'AbortError'
        ? `timed out after ${TEST_TIMEOUT_MS / 1000}s`
        : (e as Error).message;
      setTests((t) => ({ ...t, [id]: { status: 'err', err: errMsg, ranAt: Date.now() } }));
    } finally {
      clearTimeout(timer);
      inFlightTests.current.delete(ac);
    }
  };

  const resetSessions = async () => {
    if (!(await confirmDialog({ body: '确认清空所有 session（含 sub-agent 历史）？\n\n会删除 .forgeax/.../team/sessions/* 整个目录。\n下次 chat 会自动新建主 agent session；agent 配置/marketplace/games 都保留。', danger: true }))) return;
    setBusy(true);
    try {
      const r = await fetch('/api/settings/reset-sessions', { method: 'POST' });
      const j = (await r.json()) as { ok?: boolean; error?: string; removed?: number };
      if (!r.ok || !j.ok) flash('err', j.error ?? `HTTP ${r.status}`);
      else flash('ok', `已删除 ${j.removed} 个 session 目录`);
    } catch (e) {
      flash('err', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Settings">
      <div className="settings-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>系统设置</h2>
          <button className="settings-close" onClick={onClose} title="关闭 (Esc)">
            <X size={16} />
          </button>
        </div>
        {!data && <div className="settings-loading">加载中...</div>}
        {data && (
          <div className="settings-body thin-scrollbar">
            <Section icon={<Key size={14} />} title="API Keys（写入 forgeax/.env）" hint="重启 stack 后生效（FORGEAX_PROJECT_ROOT=forgeax bash run.sh）">
              <EnvField
                label="ANTHROPIC_API_KEY"
                masked={data.env.ANTHROPIC_API_KEY}
                placeholder="sk-ant-... 或 Azure Cognitive Services key"
                onSave={(v) => patchEnv({ ANTHROPIC_API_KEY: v })}
                busy={busy}
              />
              <EnvField
                label="ANTHROPIC_BASE_URL"
                masked={data.env.ANTHROPIC_BASE_URL}
                placeholder="https://api.anthropic.com 或 Azure endpoint"
                onSave={(v) => patchEnv({ ANTHROPIC_BASE_URL: v })}
                busy={busy}
                visible
              />
              <EnvField
                label="OPENAI_API_KEY (可选)"
                masked={data.env.OPENAI_API_KEY}
                placeholder="sk-..."
                onSave={(v) => patchEnv({ OPENAI_API_KEY: v })}
                busy={busy}
              />
              <EnvField
                label="GEMINI_API_KEY (可选)"
                masked={data.env.GEMINI_API_KEY}
                placeholder="AIza..."
                onSave={(v) => patchEnv({ GEMINI_API_KEY: v })}
                busy={busy}
              />
            </Section>

            <Section icon={<Cpu size={14} />} title="模型" hint="改 FORGEAX_MODEL（重启 stack 后生效）">
              <div className="settings-row">
                <label className="settings-label">当前</label>
                <select
                  className="settings-select"
                  value={data.env.FORGEAX_MODEL ?? ''}
                  onChange={(e) => void patchEnv({ FORGEAX_MODEL: e.target.value })}
                  disabled={busy}
                >
                  {MODEL_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
              <div className="settings-help">
                所有 LLM 凭证从 <code>$ROOT/.env</code> 读取；按 model id 模式自动选 adapter。
                配了 <code>LITELLM_PROXY_*</code> 时全部走代理。
              </div>
            </Section>

            <Section icon={<Plug size={14} />} title="CLI Providers" hint="多 cli 后端 — agent 由 marketplace/manifest.json#agents[].provider 路由">
              {!providers && <div className="settings-help">加载中…</div>}
              {providers && providers.length === 0 && (
                <div className="settings-help">无注册的 provider — 检查 server 启动日志。</div>
              )}
              {providers?.map((p) => {
                const caps = Object.entries(p.capabilities)
                  .filter(([, v]) => v)
                  .map(([k]) => k);
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
                        title={
                          p.health.ok
                            ? 'Send "respond with the single word: ok" and measure latency'
                            : `Provider is DOWN — ${p.health.detail ?? 'no detail'}`
                        }
                      >
                        {t?.status === 'running' ? '测试中…' : 'Test'}
                      </button>
                      {t && t.status !== 'running' && (
                        <span className="settings-help" style={{ display: 'inline', marginLeft: 8 }}>
                          {t.status === 'ok'
                            ? t.ttftMs !== undefined
                              ? `✓ ttft ${Math.round(t.ttftMs)}ms · total ${Math.round(t.totalMs ?? 0)}ms`
                              : t.sawTool
                                ? `✓ done · ${Math.round(t.totalMs ?? 0)}ms (tool-only turn — no token stream)`
                                : `✓ silent done · ${Math.round(t.totalMs ?? 0)}ms (no token + no tool events)`
                            : `✗ ${t.err?.slice(0, 80) ?? 'failed'}`}
                          {t.ranAt && (
                            <span style={{ marginLeft: 6, opacity: 0.65 }}>· {relTime(t.ranAt)}</span>
                          )}
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
                  <span style={{ fontSize: 10, color: 'var(--text-muted, rgba(255,255,255,0.4))', marginLeft: 'auto' }}>
                    快照 · {relTime(providersCachedAt)}
                  </span>
                )}
                <button
                  className="settings-edit-btn"
                  onClick={() => {
                    const ids = (providers ?? []).filter((p) => p.health.ok).map((p) => p.id);
                    void Promise.all(ids.map((id) => testProvider(id)));
                  }}
                  disabled={
                    busy ||
                    !providers ||
                    providers.every((p) => !p.health.ok) ||
                    providers.some((p) => p.health.ok && tests[p.id]?.status === 'running')
                  }
                  title="Send a 1-token chat through every healthy provider in parallel and compare latency"
                  style={{ marginLeft: providersCachedAt ? 0 : 'auto' }}
                >
                  Test all
                </button>
              </div>
            </Section>

            <Section icon={<Trash2 size={14} />} title="重置 session" hint="清空 .forgeax/.../team/sessions/* — 保留 agent 配置 / marketplace / games">
              <button className="settings-danger-btn" onClick={() => void resetSessions()} disabled={busy}>
                <RefreshCw size={12} /> 清空所有 session 历史
              </button>
              <div className="settings-help">用于「chat 卡了 / 状态混乱时」干净重启；下次发消息会建一个新主 session。</div>
            </Section>

            <Section icon={<Info size={14} />} title="关于" hint="路径 + 版本">
              <div className="settings-info">
                <div><span className="dim">project root:</span> {data.paths.projectRoot}</div>
                <div><span className="dim">env file:</span> {data.paths.envPath}</div>
                <div><span className="dim">studio:</span> <code>http://localhost:18920</code></div>
                <div><span className="dim">server api:</span> <code>http://localhost:18900</code></div>
                <div><span className="dim">cli daemon:</span> <code>http://127.0.0.1:3700</code></div>
                <div><span className="dim">engine vite:</span> <code>http://localhost:15173/preview/</code></div>
              </div>
            </Section>
          </div>
        )}
        {toast && (
          <div className={`settings-toast ${toast.kind}`}>{toast.text}</div>
        )}
      </div>
    </div>
  );
}

export function Section({ icon, title, hint, children }: { icon: React.ReactNode; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <span className="settings-section-icon">{icon}</span>
        <span className="settings-section-title">{title}</span>
      </div>
      {hint && <div className="settings-section-hint">{hint}</div>}
      <div className="settings-section-body">{children}</div>
    </div>
  );
}

export function EnvField({ label, masked, placeholder, onSave, busy, visible }: {
  label: string; masked: string | null; placeholder: string; onSave: (v: string) => void; busy: boolean; visible?: boolean;
}) {
  const stored = masked ?? '';
  // visible=true 字段(URL / deployment 名) server 直接回明文,预填到 input 让用户原地改;
  // 打码字段 server 只回 `sk-_...4UdA` 预览,input 保持空,预览塞到 placeholder——
  // 眼睛按钮切换的是用户刚输入的内容,不是把存储里的明文掏回来(那是泄密)。
  const [value, setValue] = useState<string>(visible ? stored : '');
  const [revealed, setRevealed] = useState(false);
  const trimmed = value.trim();
  const dirty = visible ? trimmed !== stored : trimmed.length > 0;

  const slot = visible ? placeholder : (masked ?? '未设置');

  const commit = () => {
    if (!trimmed || !dirty || busy) return;
    onSave(trimmed);
    if (!visible) setValue('');
    setRevealed(false);
  };

  return (
    <div className="settings-row">
      <label className="settings-label">{label}</label>
      <div className={`settings-input-wrap${visible ? '' : ' with-eye'}`}>
        <input
          className="settings-input"
          type={visible || revealed ? 'text' : 'password'}
          value={value}
          placeholder={slot ?? ''}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
          disabled={busy}
        />
        {!visible && (
          <button
            type="button"
            className="settings-eye-btn"
            onClick={() => setRevealed((v) => !v)}
            title={revealed ? '隐藏' : '显示'}
            tabIndex={-1}
          >
            {revealed ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
        )}
      </div>
      <button
        className="settings-save-btn"
        onClick={commit}
        disabled={busy || !dirty}
        title={dirty ? '' : (visible ? '没有改动' : '在上方输入新 key 后保存')}
      >保存</button>
    </div>
  );
}
