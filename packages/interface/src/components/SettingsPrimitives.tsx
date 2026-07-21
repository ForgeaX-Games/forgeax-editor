import { useEffect, useState, type ReactNode } from 'react';
import { Eye, EyeOff, UploadCloud, Copy, Check } from 'lucide-react';
import { useTranslation } from '@/i18n';

export function Section({
  icon,
  title,
  hint,
  children,
}: {
  icon: ReactNode;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
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

export function EnvField({
  label,
  masked,
  placeholder,
  onSave,
  busy,
  visible,
  notSetHint,
  onReset,
}: {
  label: string;
  masked: string | null;
  placeholder: string;
  onSave: (v: string) => void;
  busy: boolean;
  visible?: boolean;
  /** shown instead of "Not set" when the env is empty but a built-in default applies */
  notSetHint?: string;
  /** Clear the override and restore the built-in default (e.g. shared upload token). */
  onReset?: () => void;
}) {
  const { t } = useTranslation();
  const stored = masked ?? '';
  const [value, setValue] = useState<string>(visible ? stored : '');
  const [revealed, setRevealed] = useState(false);
  // Settings-panel section switches reuse this component instance at the same
  // tree position (section nodes carry no keys), so without a reset the draft
  // of e.g. ANTHROPIC_BASE_URL leaks into FORGEAX_UPLOAD_BRANCH. Re-key the
  // local state on field identity.
  useEffect(() => {
    setValue(visible ? (masked ?? '') : '');
    setRevealed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label]);
  const trimmed = value.trim();
  const dirty = visible ? trimmed !== stored : trimmed.length > 0;
  const slot = visible ? placeholder : (masked ? t('settings.drawer.savedMasked', { masked }) : (notSetHint ?? t('settings.drawer.envNotSet')));

  const commit = () => {
    if (!trimmed || !dirty || busy) return;
    onSave(trimmed);
    if (!visible) setValue('');
    setRevealed(false);
  };

  const reset = () => {
    if (!onReset || busy || !masked) return;
    onReset();
    setValue('');
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
      {onReset && (
        <button
          type="button"
          className="settings-cancel-btn"
          onClick={reset}
          disabled={busy || !masked}
          title={t('settings.upload.resetTokenTitle')}
        >
          {t('common.reset')}
        </button>
      )}
      <button
        className="settings-save-btn"
        onClick={commit}
        disabled={busy || !dirty}
        title={dirty ? '' : (visible ? t('settings.drawer.noChanges') : t('settings.drawer.enterNewKeyHint'))}
      >
        {t('common.save')}
      </button>
    </div>
  );
}

// ── Upload panel — the button path (direct HTTP, no chat involved) ───────────
//
// Same two-phase server contract as the /upload chat command, but the nonce is
// an invisible implementation detail here: plan renders as a human-readable
// preview with Confirm/Cancel buttons, confirm carries the nonce automatically.
// Business failures arrive as HTTP 200/500 + result.data.ok=false — never key
// success on the HTTP status alone (transport ok ≠ upload ok).
// (Ported from main's SettingsDrawer 763c269 — the drawer was deleted in the
// refactor; primitives consumed by @forgeax/settings live here now.)

interface UploadPlanData {
  ok: true; kind: 'plan'; namespace: string; repo: string; branch: string;
  fileCount: number; bytes: number;
  skippedSymlinks: { rel: string; target: string }[];
  skippedLarge: { rel: string; bytes: number }[];
  secretHits: { rel: string; kind: string }[];
  tokenConfigured: boolean; nonce?: string;
}
interface UploadResultData {
  ok: true; kind: 'result'; namespace: string; repoUrl: string; branch: string;
  /** repo-relative snapshot path, e.g. `<ns>/data/<ts>` */
  path: string;
  commit: string; filesChanged: number; sourceFileCount: number;
  sourceBytes: number; archiveBytes: number; bytes: number; skipped: boolean;
}
interface UploadFailureData { ok: false; kind: string; error: string }
type UploadOutcome = UploadPlanData | UploadResultData | UploadFailureData;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function callUploadCommand(args: string[]): Promise<UploadOutcome> {
  try {
    const r = await fetch('/api/commands/upload/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args }),
    });
    const j = (await r.json().catch(() => null)) as { result?: { ok: boolean; data?: unknown; error?: string } } | null;
    if (!j?.result) return { ok: false, kind: 'transport', error: `HTTP ${r.status}` };
    if (!j.result.ok) return { ok: false, kind: 'transport', error: j.result.error ?? 'command failed' };
    return j.result.data as UploadOutcome;
  } catch (e) {
    return { ok: false, kind: 'network', error: (e as Error).message };
  }
}

const PERSONAL_TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=repo&description=ForgeaX+Upload';

/** Full snapshot URL + copy button — the thing users paste back as feedback. */
function SnapshotUrlRow({ url }: { url: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // clipboard API unavailable (http / permission) — legacy path
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, maxWidth: '100%' }}>
      <code style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '0 1 auto' }}>{url}</code>
      <button className="settings-edit-btn" style={{ flex: 'none' }} onClick={() => void copy()}>
        {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? t('settings.upload.copied') : t('settings.upload.copyUrl')}
      </button>
    </div>
  );
}

export function UploadPanel({ tokenSet }: { tokenSet?: boolean }) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<'idle' | 'planning' | 'planned' | 'pushing'>('idle');
  const [plan, setPlan] = useState<UploadPlanData | null>(null);
  const [outcome, setOutcome] = useState<UploadResultData | UploadFailureData | null>(null);

  const doPlan = async () => {
    setPhase('planning'); setOutcome(null); setPlan(null);
    const res = await callUploadCommand([]);
    if (res.ok && res.kind === 'plan') { setPlan(res); setPhase('planned'); }
    else { setOutcome(res as UploadFailureData); setPhase('idle'); }
  };

  const doConfirm = async () => {
    if (!plan?.nonce) return;
    setPhase('pushing');
    const res = await callUploadCommand(['confirm', plan.nonce]);
    setOutcome(res.ok && res.kind === 'result' ? res : (res as UploadFailureData));
    setPlan(null); setPhase('idle');
  };

  const cancel = () => { setPlan(null); setPhase('idle'); };
  const running = phase === 'planning' || phase === 'pushing';
  const btnLabel =
    phase === 'planning' ? t('settings.upload.btnPlanning')
      : phase === 'pushing' ? t('settings.upload.btnPushing')
        : t('settings.upload.btnIdle');

  return (
    <div style={{ marginTop: 8 }}>
      {phase !== 'planned' && (
        <button className="settings-edit-btn" onClick={() => void doPlan()} disabled={running}>
          <UploadCloud size={12} /> {btnLabel}
        </button>
      )}
      {phase === 'idle' && !outcome && tokenSet === false && (
        <div className="settings-help" style={{ marginTop: 6 }}>
          {t('settings.upload.tokenHintPrefix')}{' '}
          <a href={PERSONAL_TOKEN_URL} target="_blank" rel="noreferrer">{t('settings.upload.tokenHintLink')}</a>{' '}
          {t('settings.upload.tokenHintSuffix')}
        </div>
      )}

      {phase === 'planned' && plan && (
        <div className="settings-help" style={{ lineHeight: 1.7 }}>
          <div>
            {t('settings.upload.planSummary', { count: plan.fileCount, bytes: fmtBytes(plan.bytes) })}{' '}
            <code>workspace.tar.gz</code> → <code>{plan.repo}</code> @ <code>{plan.branch}</code>{' '}
            {t('settings.upload.planPath', { namespace: plan.namespace })}
          </div>
          {plan.skippedSymlinks.length > 0 && (
            <div>{t('settings.upload.skippedSymlinks', { count: plan.skippedSymlinks.length })}</div>
          )}
          {plan.skippedLarge.length > 0 && (
            <div>{t('settings.upload.skippedLarge', { count: plan.skippedLarge.length })}</div>
          )}
          {plan.secretHits.length > 0 && (
            <div style={{ color: 'var(--danger, #e5534b)' }}>
              {t('settings.upload.secretBlocked', {
                count: plan.secretHits.length,
                samples: plan.secretHits.slice(0, 3).map((h) => h.rel).join(', '),
              })}
            </div>
          )}
          {!plan.tokenConfigured && (
            <div style={{ color: 'var(--danger, #e5534b)' }}>
              {t('settings.upload.tokenMissingTitle')}
              <br />
              {t('settings.upload.tokenMissingStep1Before')}
              <a href={PERSONAL_TOKEN_URL} target="_blank" rel="noreferrer" style={{ color: 'inherit', textDecoration: 'underline' }}>
                {t('settings.upload.tokenMissingStep1Link')}
              </a>
              {t('settings.upload.tokenMissingStep1After')}
              <br />
              {t('settings.upload.tokenMissingStep2')}
              <br />
              {t('settings.upload.tokenMissingStep3')}
            </div>
          )}
          {plan.fileCount === 0 && <div>{t('settings.upload.empty')}</div>}
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            {plan.nonce && (
              <button className="settings-edit-btn" onClick={() => void doConfirm()}>
                {t('settings.upload.confirm')}
              </button>
            )}
            <button className="settings-edit-btn" onClick={cancel}>{t('settings.upload.cancel')}</button>
          </div>
        </div>
      )}

      {outcome && (
        <div className="settings-help" style={{ marginTop: 6 }}>
          {outcome.ok ? (
            <>
              {outcome.skipped ? (
                <span>
                  <span className="ok-pill">{t('settings.upload.skippedSame')}</span>{' '}
                  <a href={`${outcome.repoUrl}/tree/${outcome.branch}/${outcome.path}`} target="_blank" rel="noreferrer">
                    {t('settings.upload.viewExisting')}
                  </a>
                </span>
              ) : (
                <span>
                  <span className="ok-pill">
                    {t('settings.upload.uploaded', {
                      count: outcome.sourceFileCount,
                      sourceBytes: fmtBytes(outcome.sourceBytes),
                      archiveBytes: fmtBytes(outcome.archiveBytes),
                    })}
                  </span>{' '}
                  <a href={`${outcome.repoUrl}/tree/${outcome.branch}/${outcome.path}`} target="_blank" rel="noreferrer">
                    {t('settings.upload.viewSnapshot')}
                  </a>{' '}
                  <a href={`${outcome.repoUrl}/tree/${outcome.branch}/${outcome.namespace}/data`} target="_blank" rel="noreferrer">
                    {t('settings.upload.allVersions')}
                  </a>{' '}
                  <code>@{outcome.commit.slice(0, 7)}</code>
                </span>
              )}
              <SnapshotUrlRow url={`${outcome.repoUrl}/raw/${outcome.branch}/${outcome.path}/workspace.tar.gz`} />
            </>
          ) : (
            <span className="err-pill" style={{ whiteSpace: 'normal' }}>
              {t('settings.upload.failed', { error: outcome.error })}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
