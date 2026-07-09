import { useEffect, useRef, useState } from 'react';
import { X, Key, Cpu, Trash2, RefreshCw, Info, Plug, Eye, EyeOff } from 'lucide-react';
import { confirmDialog } from '@/lib/dialog';
import { useTranslation } from '@/i18n';

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

// LLM 鉴权/路由 key —— 改这些会换掉「代理暴露哪些模型」(尤其切 LiteLLM 代理),
// 故保存成功后要强制重拉模型目录(浏览器 window 缓存不会自己失效)。镜像 server 侧
// SIDECAR_CRED_KEYS(cli/src/api/settings.ts)。
const LLM_CRED_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'GEMINI_API_KEY',
  'LITELLM_PROXY_KEY',
  'LITELLM_PROXY_BASE_URL',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
]);

const MODEL_OPTIONS = [
  { value: 'claude-opus-4-7', label: 'Claude Opus 4.7 (current)' },
  { value: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
];

export function SettingsDrawer({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
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
    const tick = setInterval(() => setNowTick((v) => v + 1), 1000);
    return () => clearInterval(tick);
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
    if (s < 5) return t('settings.drawer.relTimeJustNow');
    if (s < 60) return t('settings.drawer.relTimeSecondsAgo', { seconds: s });
    const m = Math.floor(s / 60);
    return t('settings.drawer.relTimeMinutesAgo', { minutes: m });
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
        flash('ok', t('settings.env.saved', { count: j.touched ?? 0 }));
        await reload();
        // 改了 LLM 凭据 → 强制重拉模型目录(新 key/base-url 可能换掉可用模型;server 侧
        // 缓存按 key 自失效,但浏览器 window 缓存不会 → 这里主动刷,让选择器免刷新即更新)。
        if (Object.keys(patch).some((k) => LLM_CRED_KEYS.has(k))) {
          try {
            const { refreshAllModelCatalogs } = await import('../ModelPicker/useModelCatalog');
            await refreshAllModelCatalogs();
          } catch { /* 模型刷新失败不影响凭据已保存 */ }
        }
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
    setTests((prev) => ({ ...prev, [id]: { status: 'running' } }));
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
      if (errText) setTests((prev) => ({ ...prev, [id]: { status: 'err', totalMs: total, err: errText, ranAt } }));
      else setTests((prev) => ({ ...prev, [id]: { status: 'ok', totalMs: total, ttftMs: ttft, sawTool, ranAt } }));
    } catch (e) {
      const errName = (e as Error).name;
      const errMsg = errName === 'AbortError'
        ? `timed out after ${TEST_TIMEOUT_MS / 1000}s`
        : (e as Error).message;
      setTests((prev) => ({ ...prev, [id]: { status: 'err', err: errMsg, ranAt: Date.now() } }));
    } finally {
      clearTimeout(timer);
      inFlightTests.current.delete(ac);
    }
  };

  const resetSessions = async () => {
    if (!(await confirmDialog({ body: t('settings.drawer.resetSessionsConfirm'), danger: true }))) return;
    setBusy(true);
    try {
      const r = await fetch('/api/settings/reset-sessions', { method: 'POST' });
      const j = (await r.json()) as { ok?: boolean; error?: string; removed?: number };
      if (!r.ok || !j.ok) flash('err', j.error ?? `HTTP ${r.status}`);
      else flash('ok', t('settings.drawer.resetSessionsDone', { count: j.removed ?? 0 }));
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
          <h2>{t('settings.drawer.title')}</h2>
          <button className="settings-close" onClick={onClose} title={t('settings.drawer.closeTitle')}>
            <X size={16} />
          </button>
        </div>
        {!data && <div className="settings-loading">{t('common.loading')}</div>}
        {data && (
          <div className="settings-body thin-scrollbar">
            <Section icon={<Key size={14} />} title={t('settings.drawer.apiKeysTitle')} hint={t('settings.drawer.apiKeysHint')}>
              <EnvField
                label="ANTHROPIC_API_KEY"
                masked={data.env.ANTHROPIC_API_KEY}
                placeholder={t('settings.drawer.anthropicKeyPlaceholder')}
                onSave={(v) => patchEnv({ ANTHROPIC_API_KEY: v })}
                busy={busy}
              />
              <EnvField
                label="ANTHROPIC_BASE_URL"
                masked={data.env.ANTHROPIC_BASE_URL}
                placeholder={t('settings.drawer.anthropicBaseUrlPlaceholder')}
                onSave={(v) => patchEnv({ ANTHROPIC_BASE_URL: v })}
                busy={busy}
                visible
              />
              <EnvField
                label={t('settings.drawer.openaiKeyLabel')}
                masked={data.env.OPENAI_API_KEY}
                placeholder="sk-..."
                onSave={(v) => patchEnv({ OPENAI_API_KEY: v })}
                busy={busy}
              />
              <EnvField
                label={t('settings.drawer.geminiKeyLabel')}
                masked={data.env.GEMINI_API_KEY}
                placeholder="AIza..."
                onSave={(v) => patchEnv({ GEMINI_API_KEY: v })}
                busy={busy}
              />
            </Section>

            <Section icon={<Cpu size={14} />} title={t('settings.drawer.modelTitle')} hint={t('settings.drawer.modelHint')}>
              <div className="settings-row">
                <label className="settings-label">{t('settings.drawer.modelCurrent')}</label>
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
                {t('settings.drawer.modelHelpPrefix')} <code>$ROOT/.env</code> {t('settings.drawer.modelHelpAdapter')}
                {' '}{t('settings.drawer.modelHelpProxyPrefix')} <code>LITELLM_PROXY_*</code> {t('settings.drawer.modelHelpProxySuffix')}
              </div>
            </Section>

            <Section icon={<Plug size={14} />} title="CLI Providers" hint={t('settings.drawer.cliProvidersHint')}>
              {!providers && <div className="settings-help">{t('common.loading')}</div>}
              {providers && providers.length === 0 && (
                <div className="settings-help">{t('settings.drawer.cliProvidersNone')}</div>
              )}
              {providers?.map((p) => {
                const caps = Object.entries(p.capabilities)
                  .filter(([, v]) => v)
                  .map(([k]) => k);
                const tr = tests[p.id];
                return (
                  <div key={p.id} className={`settings-provider-row ${!p.health.ok ? 'is-down' : ''}`}>
                    <div className="settings-provider-head">
                      <code className="settings-provider-id">{p.id}</code>
                      <span className="settings-provider-name">{p.displayName}</span>
                      <span className={p.health.ok ? 'ok-pill' : 'err-pill'}>
                        {p.health.ok ? t('settings.drawer.providerHealthy') : t('settings.drawer.providerUnavailable')}
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
                        disabled={tr?.status === 'running' || !p.health.ok}
                        title={
                          p.health.ok
                            ? 'Send "respond with the single word: ok" and measure latency'
                            : `Provider is DOWN — ${p.health.detail ?? 'no detail'}`
                        }
                      >
                        {tr?.status === 'running' ? t('settings.drawer.providerTesting') : 'Test'}
                      </button>
                      {tr && tr.status !== 'running' && (
                        <span className="settings-help" style={{ display: 'inline', marginLeft: 8 }}>
                          {tr.status === 'ok'
                            ? tr.ttftMs !== undefined
                              ? `✓ ttft ${Math.round(tr.ttftMs)}ms · total ${Math.round(tr.totalMs ?? 0)}ms`
                              : tr.sawTool
                                ? `✓ done · ${Math.round(tr.totalMs ?? 0)}ms (tool-only turn — no token stream)`
                                : `✓ silent done · ${Math.round(tr.totalMs ?? 0)}ms (no token + no tool events)`
                            : `✗ ${tr.err?.slice(0, 80) ?? 'failed'}`}
                          {tr.ranAt && (
                            <span style={{ marginLeft: 6, opacity: 0.65 }}>· {relTime(tr.ranAt)}</span>
                          )}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
              <div style={{ display: 'flex', gap: 6, marginTop: 4, alignItems: 'center' }}>
                <button className="settings-edit-btn" onClick={() => void reloadProviders(true)} disabled={busy}>
                  <RefreshCw size={11} /> {t('settings.refresh')}
                </button>
                {providersCachedAt && (
                  <span style={{ fontSize: 10, color: 'var(--text-muted, rgba(255,255,255,0.4))', marginLeft: 'auto' }}>
                    {t('settings.drawer.snapshot')} {relTime(providersCachedAt)}
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

            <Section icon={<Trash2 size={14} />} title={t('settings.drawer.resetSessionsTitle')} hint={t('settings.drawer.resetSessionsHint')}>
              <button className="settings-danger-btn" onClick={() => void resetSessions()} disabled={busy}>
                <RefreshCw size={12} /> {t('settings.drawer.resetSessionsBtn')}
              </button>
              <div className="settings-help">{t('settings.drawer.resetSessionsHelp')}</div>
            </Section>

            <Section icon={<Info size={14} />} title={t('settings.drawer.aboutTitle')} hint={t('settings.drawer.aboutHint')}>
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
  const { t } = useTranslation();
  const stored = masked ?? '';
  // visible=true 字段(URL / deployment 名) server 直接回明文,预填到 input 让用户原地改;
  // 打码字段 server 只回 `sk-_...4UdA` 预览,input 保持空,预览塞到 placeholder——
  // 眼睛按钮切换的是用户刚输入的内容,不是把存储里的明文掏回来(那是泄密)。
  const [value, setValue] = useState<string>(visible ? stored : '');
  const [revealed, setRevealed] = useState(false);
  const trimmed = value.trim();
  const dirty = visible ? trimmed !== stored : trimmed.length > 0;

  const slot = visible ? placeholder : (masked ?? t('settings.drawer.envNotSet'));

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
            title={revealed ? t('settings.drawer.hide') : t('settings.drawer.show')}
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
        title={dirty ? '' : (visible ? t('settings.drawer.noChanges') : t('settings.drawer.enterNewKeyHint'))}
      >{t('common.save')}</button>
    </div>
  );
}
