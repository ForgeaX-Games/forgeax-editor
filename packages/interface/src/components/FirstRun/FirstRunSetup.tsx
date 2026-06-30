import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTranslation } from '@/i18n';
import { useAppStore } from '../../store';

// First-run onboarding. Shows a skippable two-step guide when no LLM credential
// is configured. The default backend is OpenRouter: the user pastes an
// OpenRouter key (sk-or-...) which we store as ANTHROPIC_AUTH_TOKEN (Bearer)
// with ANTHROPIC_BASE_URL=https://openrouter.ai/api and a blanked
// ANTHROPIC_API_KEY — the exact shape claude-code needs to talk to OpenRouter's
// Anthropic skin (https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration).
//
// Three exits (none forced): ① fill an OpenRouter key, ② use a locally-installed
// CLI (claude-code/codex/cursor — login covers auth, no key needed here),
// ③ skip. Choosing ② or ③ records a localStorage flag so the guide never nags
// again, and deep-links into the matching Settings section so the user can come
// back any time. Writes go through PUT /api/settings/env, which live-applies to
// process.env so the running server picks creds up without a restart.

const SEEN_KEY = 'forgeax.onboarding.seen';
const OPENROUTER_BASE = 'https://openrouter.ai/api';
const OPENROUTER_KEYS_URL = 'https://openrouter.ai/keys';

type Step = 'intro' | 'key';

export function FirstRunSetup() {
  const { t } = useTranslation();
  const openSettings = useAppStore((s) => s.openSettings);
  const [needsKey, setNeedsKey] = useState(false);
  const [step, setStep] = useState<Step>('intro');
  const [key, setKey] = useState('');
  const [reveal, setReveal] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [baseUrl, setBaseUrl] = useState(OPENROUTER_BASE);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (localStorage.getItem(SEEN_KEY)) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/settings');
        const j = (await r.json()) as {
          env?: { ANTHROPIC_API_KEY?: string | null; ANTHROPIC_AUTH_TOKEN?: string | null };
        };
        // maskKey() returns null when a key is unset. Pop only when BOTH the
        // OpenRouter token and the legacy API key are absent — otherwise a
        // configured user (either path) would still be nagged.
        if (!cancelled && j?.env && j.env.ANTHROPIC_AUTH_TOKEN == null && j.env.ANTHROPIC_API_KEY == null) {
          setNeedsKey(true);
        }
      } catch { /* server not ready / no settings API — don't block */ }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!needsKey) return null;

  const markSeen = () => { try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* ignore */ } };

  // Non-blocking: a plain dismiss (X / backdrop click / "skip") just records the
  // seen flag and closes — no forced navigation. Users who already have a local
  // CLI logged in can leave immediately. "useLocalCli" additionally deep-links
  // to the CLI Providers settings so they can verify/select their CLI.
  const dismiss = () => { markSeen(); setNeedsKey(false); };
  const useLocalCli = () => { markSeen(); setNeedsKey(false); openSettings('cli-providers'); };

  const save = async () => {
    if (!key.trim()) { setErr(t('firstRun.errMissingKey')); return; }
    setBusy(true); setErr(null);
    try {
      // OpenRouter via claude-code: key → ANTHROPIC_AUTH_TOKEN (Bearer),
      // base → ANTHROPIC_BASE_URL, and ANTHROPIC_API_KEY MUST be blanked or
      // claude-code falls back to authenticating against api.anthropic.com.
      const patch: Record<string, string> = {
        ANTHROPIC_AUTH_TOKEN: key.trim(),
        ANTHROPIC_BASE_URL: baseUrl.trim() || OPENROUTER_BASE,
        ANTHROPIC_API_KEY: '',
      };
      const r = await fetch('/api/settings/env', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const j = (await r.json()) as { error?: string };
      if (!r.ok || j.error) { setErr(j.error ?? t('firstRun.errSaveFailed')); setBusy(false); return; }
      markSeen();
      setNeedsKey(false);
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  const keysLink = (
    <a style={link} href={OPENROUTER_KEYS_URL} target="_blank" rel="noreferrer">openrouter.ai/keys</a>
  );

  return (
    <div style={overlay} onClick={(e) => { if (e.target === e.currentTarget) dismiss(); }}>
      <div style={card}>
        <button style={closeBtn} onClick={dismiss} title={t('firstRun.skip')} aria-label={t('firstRun.skip')}>×</button>
        <div style={stepDots}>
          <span style={dot(step === 'intro')} />
          <span style={dotLine} />
          <span style={dot(step === 'key')} />
        </div>

        {step === 'intro' ? (
          <>
            <h2 style={title}>{t('firstRun.title')}</h2>
            <p style={lead}>{t('firstRun.lead')}</p>
            <div style={optionBox}>
              <div style={optTitle}>
                {t('firstRun.opt1Title')}<span style={badge}>{t('firstRun.opt1Badge')}</span>
              </div>
              <div style={optDesc}>
                {t('firstRun.opt1DescBefore')}{keysLink}{t('firstRun.opt1DescAfter')}
              </div>
            </div>
            <div style={optionBox}>
              <div style={optTitle}>{t('firstRun.opt2Title')}</div>
              <div style={optDesc}>{t('firstRun.opt2Desc')}</div>
            </div>
            <div style={btnRow}>
              <button style={btnGhost} onClick={dismiss}>{t('firstRun.skip')}</button>
              <div style={{ flex: 1 }} />
              <button style={btnGhost} onClick={useLocalCli}>{t('firstRun.useLocalCli')}</button>
              <button style={btnPrimary} onClick={() => { setErr(null); setStep('key'); }}>{t('firstRun.fillKey')}</button>
            </div>
          </>
        ) : (
          <>
            <h2 style={title}>{t('firstRun.step2Title')}</h2>
            <p style={lead}>{t('firstRun.step2LeadBefore')}{keysLink}{t('firstRun.step2LeadAfter')}</p>
            <div style={inputWrap}>
              <input
                style={input}
                type={reveal ? 'text' : 'password'}
                placeholder={t('firstRun.keyPlaceholder')}
                value={key}
                autoFocus
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void save(); }}
              />
              <button style={eyeBtn} onClick={() => setReveal((v) => !v)}>{reveal ? '🙈' : '👁'}</button>
            </div>

            <button style={advToggle} onClick={() => setShowAdvanced((v) => !v)}>
              {showAdvanced ? '▾' : '▸'} {t('firstRun.advanced')}
            </button>
            {showAdvanced && (
              <input
                style={input}
                type="text"
                placeholder={OPENROUTER_BASE}
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            )}

            {err && <div style={errText}>{err}</div>}
            <div style={btnRow}>
              <button style={btnGhost} disabled={busy} onClick={() => { setErr(null); setStep('intro'); }}>{t('firstRun.back')}</button>
              <div style={{ flex: 1 }} />
              <button style={btnPrimary} disabled={busy} onClick={() => void save()}>
                {busy ? t('firstRun.saving') : t('firstRun.saveAndStart')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const overlay: CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 'var(--z-toplevel)', background: 'rgba(10,10,15,.85)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};
const card: CSSProperties = {
  position: 'relative',
  background: '#1a1a22', border: '1px solid #333', borderRadius: 12, padding: 28,
  width: 460, maxWidth: '92vw', font: '14px/1.55 system-ui,sans-serif', color: '#eee',
  boxShadow: '0 20px 60px rgba(0,0,0,.5)',
};
const closeBtn: CSSProperties = {
  position: 'absolute', top: 10, right: 12, background: 'transparent', border: 'none',
  color: '#888', fontSize: 22, lineHeight: 1, cursor: 'pointer', padding: 4,
};
const stepDots: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 14 };
const dot = (active: boolean): CSSProperties => ({
  width: 8, height: 8, borderRadius: '50%', background: active ? '#5b8cff' : '#444',
});
const dotLine: CSSProperties = { width: 24, height: 2, background: '#444' };
const title: CSSProperties = { margin: '0 0 8px', fontSize: 18 };
const lead: CSSProperties = { opacity: 0.75, margin: '0 0 16px', fontSize: 13 };
const optionBox: CSSProperties = {
  border: '1px solid #333', borderRadius: 8, padding: '10px 12px', marginBottom: 10, background: '#13131a',
};
const optTitle: CSSProperties = { fontSize: 14, fontWeight: 600, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 };
const badge: CSSProperties = {
  fontSize: 11, fontWeight: 500, color: '#9ec1ff', background: 'rgba(91,140,255,.15)',
  border: '1px solid rgba(91,140,255,.35)', borderRadius: 999, padding: '1px 8px',
};
const optDesc: CSSProperties = { fontSize: 12.5, opacity: 0.8 };
const link: CSSProperties = { color: '#7aa2ff' };
const inputWrap: CSSProperties = { position: 'relative', marginBottom: 10 };
const input: CSSProperties = {
  width: '100%', boxSizing: 'border-box', marginBottom: 10, padding: '10px 12px',
  borderRadius: 8, border: '1px solid #444', background: '#0e0e14', color: '#eee', fontSize: 13,
};
const eyeBtn: CSSProperties = {
  position: 'absolute', right: 8, top: 7, background: 'transparent', border: 'none',
  cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: 4,
};
const advToggle: CSSProperties = {
  background: 'transparent', border: 'none', color: '#9aa', cursor: 'pointer',
  fontSize: 12.5, padding: '2px 0', marginBottom: 6, textAlign: 'left',
};
const errText: CSSProperties = { color: '#ff8a8a', fontSize: 12, marginBottom: 8 };
const btnRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 };
const btnPrimary: CSSProperties = {
  padding: '10px 16px', borderRadius: 8, border: 'none', background: '#5b8cff',
  color: '#fff', fontWeight: 600, cursor: 'pointer', fontSize: 14,
};
const btnGhost: CSSProperties = {
  padding: '10px 14px', borderRadius: 8, border: '1px solid #444', background: 'transparent',
  color: '#cfd2da', fontWeight: 500, cursor: 'pointer', fontSize: 13,
};
