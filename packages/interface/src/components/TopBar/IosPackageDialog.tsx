import { useState, useRef, type ChangeEvent } from 'react';
import { Apple, Image as ImageIcon, Trash2, RectangleHorizontal, RectangleVertical } from 'lucide-react';
import './TopBar.css';

export type IosOrientation = 'portrait' | 'landscape';

export interface IosPackageConfig {
  iosBundleId: string;
  iosAppName: string;
  iosProjectName: string;
  iosIcon?: { dataBase64: string; filename: string };
  iosOrientation: IosOrientation;
}

// Mirror the backend validation (IosPackager.ts) so bad input is caught before
// the round-trip; the backend still re-validates as a safety net.
const BUNDLE_ID_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const PROJECT_NAME_RE = /^[A-Za-z0-9_-]+$/;
const MAX_ICON_BYTES = 2 * 1024 * 1024;

/** Derive a sane default bundle identifier from a slug (matches the backend). */
export function defaultIosBundleId(slug: string): string {
  let seg = slug.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  if (!seg) seg = 'app';
  if (/^[0-9]/.test(seg)) seg = `g${seg}`;
  return `com.forgeax.game.${seg}`;
}

type T = (k: string, opts?: Record<string, string | number>) => string;

export function IosPackageDialog({ slug, defaultAppName, onCancel, onConfirm, t }: {
  slug: string;
  defaultAppName: string;
  onCancel: () => void;
  onConfirm: (cfg: IosPackageConfig) => void;
  t: T;
}) {
  const [bundleId, setBundleId] = useState(defaultIosBundleId(slug));
  const [appName, setAppName] = useState(defaultAppName || slug);
  const [projectName, setProjectName] = useState(slug);
  const [orientation, setOrientation] = useState<IosOrientation>('landscape');
  const [icon, setIcon] = useState<{ dataBase64: string; filename: string; previewUrl: string } | undefined>();
  const [iconError, setIconError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const bundleIdValid = BUNDLE_ID_RE.test(bundleId.trim());
  const appNameValid = appName.trim().length >= 1 && appName.trim().length <= 30;
  const projectNameValid = PROJECT_NAME_RE.test(projectName.trim());
  const canSubmit = bundleIdValid && appNameValid && projectNameValid && !iconError;

  const onPickIcon = (e: ChangeEvent<HTMLInputElement>) => {
    setIconError('');
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type !== 'image/png') { setIconError(t('topbar.ios.iconErrType')); return; }
    if (file.size > MAX_ICON_BYTES) { setIconError(t('topbar.ios.iconErrSize')); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '');
      const comma = dataUrl.indexOf(',');
      const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : '';
      setIcon({ dataBase64: b64, filename: file.name, previewUrl: dataUrl });
    };
    reader.onerror = () => setIconError(t('topbar.ios.iconErrType'));
    reader.readAsDataURL(file);
  };

  const submit = () => {
    if (!canSubmit) return;
    onConfirm({
      iosBundleId: bundleId.trim(),
      iosAppName: appName.trim(),
      iosProjectName: projectName.trim(),
      iosIcon: icon ? { dataBase64: icon.dataBase64, filename: icon.filename } : undefined,
      iosOrientation: orientation,
    });
  };

  const labelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 600, marginBottom: 4, display: 'block' };
  const inputStyle: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', fontSize: 13, padding: '6px 8px', borderRadius: 4,
    border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(0,0,0,0.25)', color: 'inherit',
  };
  const hintStyle: React.CSSProperties = { fontSize: 11, opacity: 0.6, marginTop: 3 };
  const errStyle: React.CSSProperties = { fontSize: 11, color: '#f87171', marginTop: 3 };

  return (
    <div className="tb-progress-overlay" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="tb-progress-dialog" style={{ minWidth: 440, maxWidth: 520 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <Apple size={16} />
          <span style={{ fontWeight: 600, fontSize: 14 }}>{t('topbar.ios.title')}</span>
        </div>
        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 14 }}>{t('topbar.ios.subtitle')}</div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>{t('topbar.ios.bundleIdLabel')}</label>
          <input
            style={{ ...inputStyle, borderColor: bundleIdValid ? inputStyle.border as string : '#f87171' }}
            value={bundleId}
            spellCheck={false}
            autoCapitalize="off"
            onChange={(e) => setBundleId(e.target.value)}
            placeholder="com.acme.mygame"
          />
          {bundleIdValid
            ? <div style={hintStyle}>{t('topbar.ios.bundleIdHint')}</div>
            : <div style={errStyle}>{t('topbar.ios.bundleIdError')}</div>}
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>{t('topbar.ios.appNameLabel')}</label>
          <input
            style={{ ...inputStyle, borderColor: appNameValid ? inputStyle.border as string : '#f87171' }}
            value={appName}
            onChange={(e) => setAppName(e.target.value)}
            maxLength={30}
          />
          {!appNameValid && <div style={errStyle}>{t('topbar.ios.appNameError')}</div>}
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>{t('topbar.ios.projectNameLabel')}</label>
          <input
            style={{ ...inputStyle, borderColor: projectNameValid ? inputStyle.border as string : '#f87171' }}
            value={projectName}
            spellCheck={false}
            autoCapitalize="off"
            onChange={(e) => setProjectName(e.target.value)}
          />
          {projectNameValid
            ? <div style={hintStyle}>{t('topbar.ios.projectNameHint')}</div>
            : <div style={errStyle}>{t('topbar.ios.projectNameError')}</div>}
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>{t('topbar.ios.orientationLabel')}</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {([
              { value: 'landscape' as const, icon: <RectangleHorizontal size={14} />, label: t('topbar.ios.orientationLandscape') },
              { value: 'portrait' as const, icon: <RectangleVertical size={14} />, label: t('topbar.ios.orientationPortrait') },
            ]).map((opt) => {
              const active = orientation === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setOrientation(opt.value)}
                  style={{
                    flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    fontSize: 12, cursor: 'pointer', padding: '7px 10px', borderRadius: 4,
                    border: `1px solid ${active ? 'var(--accent, #3b82f6)' : 'rgba(255,255,255,0.15)'}`,
                    background: active ? 'rgba(59,130,246,0.18)' : 'rgba(0,0,0,0.25)',
                    color: 'inherit', fontWeight: active ? 600 : 400,
                  }}
                >
                  {opt.icon}
                  {opt.label}
                </button>
              );
            })}
          </div>
          <div style={hintStyle}>{t('topbar.ios.orientationHint')}</div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>{t('topbar.ios.iconLabel')}</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 56, height: 56, borderRadius: 10, flexShrink: 0,
              border: '1px solid rgba(255,255,255,0.15)', overflow: 'hidden',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(0,0,0,0.25)',
            }}>
              {icon
                ? <img src={icon.previewUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                : <ImageIcon size={22} style={{ opacity: 0.4 }} />}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <button
                type="button"
                onClick={() => { const el = fileInputRef.current; if (el) { el.value = ''; el.click(); } }}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer',
                  padding: '5px 10px', borderRadius: 4, border: '1px solid rgba(255,255,255,0.18)',
                  background: 'transparent', color: 'inherit',
                }}
              >
                <ImageIcon size={13} />
                {t('topbar.ios.iconPick')}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png"
                style={{ display: 'none' }}
                onChange={onPickIcon}
              />
              {icon && (
                <button
                  type="button"
                  onClick={() => { setIcon(undefined); setIconError(''); }}
                  title={t('topbar.ios.iconRemove')}
                  style={{
                    marginLeft: 8, fontSize: 12, cursor: 'pointer', background: 'none',
                    border: 'none', color: 'inherit', opacity: 0.6, display: 'inline-flex',
                    alignItems: 'center', gap: 3, verticalAlign: 'middle',
                  }}
                >
                  <Trash2 size={12} /> {t('topbar.ios.iconRemove')}
                </button>
              )}
              <div style={hintStyle}>{icon ? icon.filename : t('topbar.ios.iconHint')}</div>
              {iconError && <div style={errStyle}>{iconError}</div>}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              fontSize: 13, cursor: 'pointer', padding: '6px 14px', borderRadius: 4,
              border: '1px solid rgba(255,255,255,0.18)', background: 'transparent', color: 'inherit',
            }}
          >
            {t('topbar.ios.cancel')}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            style={{
              fontSize: 13, cursor: canSubmit ? 'pointer' : 'not-allowed', padding: '6px 14px',
              borderRadius: 4, border: 'none', color: '#fff',
              background: canSubmit ? 'var(--accent, #3b82f6)' : 'rgba(120,120,120,0.4)',
            }}
          >
            {t('topbar.ios.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
