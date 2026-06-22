import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTranslation } from '@/i18n';

// First-run API-key onboarding (U3). Shows a blocking overlay when no
// ANTHROPIC_API_KEY is configured — the main gap for the bundled desktop .app,
// where ~/ForgeaxProjects/.env doesn't exist on a fresh install (and harmless in
// the web form, where deploy.sh normally seeds the key). Writes via the existing
// PUT /api/settings/env, which now also live-applies to process.env so the
// running server picks the key up without a restart.
export function FirstRunSetup() {
  const { t } = useTranslation();
  const [needsKey, setNeedsKey] = useState(false);
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/settings');
        const j = (await r.json()) as { env?: { ANTHROPIC_API_KEY?: string | null } };
        // maskKey() returns null when the key is unset.
        if (!cancelled && j?.env && j.env.ANTHROPIC_API_KEY == null) setNeedsKey(true);
      } catch { /* server not ready / no settings API — don't block */ }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!needsKey) return null;

  const save = async () => {
    if (!key.trim()) { setErr(t('firstRun.errMissingKey')); return; }
    setBusy(true); setErr(null);
    try {
      const patch: Record<string, string> = { ANTHROPIC_API_KEY: key.trim() };
      if (baseUrl.trim()) patch.ANTHROPIC_BASE_URL = baseUrl.trim();
      const r = await fetch('/api/settings/env', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const j = (await r.json()) as { error?: string };
      if (!r.ok || j.error) { setErr(j.error ?? t('firstRun.errSaveFailed')); setBusy(false); return; }
      setNeedsKey(false);
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  return (
    <div style={overlay}>
      <div style={card}>
        <h2 style={{ margin: '0 0 8px', fontSize: 18 }}>{t('firstRun.title')}</h2>
        <p style={{ opacity: 0.7, margin: '0 0 16px', fontSize: 13 }}>
          {t('firstRun.introBefore')} <code>~/ForgeaxProjects/.env</code>{t('firstRun.introAfter')}
        </p>
        <input style={input} type="password" placeholder="sk-ant-..." value={key}
          onChange={(e) => setKey(e.target.value)} autoFocus
          onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} />
        <input style={input} type="text" placeholder={t('firstRun.baseUrlPlaceholder')} value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)} />
        {err && <div style={{ color: '#ff8a8a', fontSize: 12, marginBottom: 8 }}>{err}</div>}
        <button style={btn} disabled={busy} onClick={() => void save()}>
          {busy ? t('firstRun.saving') : t('firstRun.saveAndStart')}
        </button>
      </div>
    </div>
  );
}

const overlay: CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 'var(--z-toplevel)', background: 'rgba(10,10,15,.85)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};
const card: CSSProperties = {
  background: '#1a1a22', border: '1px solid #333', borderRadius: 12, padding: 28,
  width: 420, maxWidth: '90vw', font: '14px/1.5 system-ui,sans-serif', color: '#eee',
  boxShadow: '0 20px 60px rgba(0,0,0,.5)',
};
const input: CSSProperties = {
  width: '100%', boxSizing: 'border-box', marginBottom: 10, padding: '10px 12px',
  borderRadius: 8, border: '1px solid #444', background: '#0e0e14', color: '#eee', fontSize: 13,
};
const btn: CSSProperties = {
  width: '100%', padding: 10, borderRadius: 8, border: 'none', background: '#5b8cff',
  color: '#fff', fontWeight: 600, cursor: 'pointer', fontSize: 14,
};
