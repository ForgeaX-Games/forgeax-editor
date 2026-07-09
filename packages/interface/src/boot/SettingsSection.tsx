import { useMemo, type ReactNode } from 'react';
import { Sparkles, RefreshCw } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { Section } from '../components/SettingsPrimitives';
import { SPLASH_THEMES, themeById } from './themes';
import { useSplashConfig } from './store';
import { DEFAULT_SPLASH, type SplashConfig, type SplashThemeId } from './types';

/**
 * SettingsPanel section node for the boot splash.
 *
 * The boot splash itself is rendered by `index.html` BEFORE React mounts —
 * this section only writes the persisted config. A "应用并刷新预览" button
 * triggers a full reload so the player can actually see the splash they
 * just configured (the inline script reads localStorage on page-load).
 *
 * AI / external clients can also POST /api/boot-splash to mutate this same
 * config — the store reconciles server → client on mount and writes back
 * on every save.
 */
export function BootSplashSection(): ReactNode {
  const { t } = useTranslation();
  const [cfg, setCfg] = useSplashConfig();

  const update = (patch: Partial<SplashConfig>): void => {
    setCfg({ ...cfg, ...patch });
  };

  const active = themeById(cfg.theme);

  const preview = useMemo(() => (
    <div
      style={{
        marginTop: 8,
        padding: '10px 12px',
        borderRadius: 8,
        border: `1px solid ${active.swatch}44`,
        background: `linear-gradient(135deg, ${active.swatch}10, transparent 70%), rgba(20,24,28,0.6)`,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}
      aria-label="splash preview swatch"
    >
      <span
        style={{
          width: 9,
          height: 9,
          borderRadius: '50%',
          background: active.swatch,
          boxShadow: `0 0 8px ${active.swatch}88`,
          flexShrink: 0,
        }}
      />
      <span style={{ color: active.swatch, fontWeight: 600, fontSize: 13 }}>{cfg.title}</span>
      <span style={{ marginLeft: 'auto', fontSize: 11, opacity: 0.55 }}>{cfg.subtitle}</span>
    </div>
  ), [active, cfg.title, cfg.subtitle]);

  return (
    <>
      <Section
        icon={<Sparkles size={14} />}
        title={t('boot.theme.title')}
        hint={t('boot.theme.hint')}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {SPLASH_THEMES.map((theme) => {
            const checked = theme.id === cfg.theme;
            return (
              <label
                key={theme.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: '8px 10px',
                  borderRadius: 6,
                  border: `1px solid ${checked ? theme.swatch + '55' : 'rgba(255,255,255,0.06)'}`,
                  background: checked ? `${theme.swatch}0d` : 'transparent',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="radio"
                  name="splash-theme"
                  checked={checked}
                  onChange={() => update({ theme: theme.id as SplashThemeId })}
                  style={{ marginTop: 3, accentColor: theme.swatch }}
                />
                <span
                  aria-hidden
                  style={{
                    width: 10, height: 10, borderRadius: '50%',
                    background: theme.swatch,
                    boxShadow: `0 0 6px ${theme.swatch}88`,
                    flexShrink: 0,
                    marginTop: 5,
                  }}
                />
                <span style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: checked ? theme.swatch : 'var(--text-secondary)' }}>
                    {t(theme.labelKey)}
                  </span>
                  <span style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>{t(theme.descKey)}</span>
                </span>
              </label>
            );
          })}
        </div>
        {preview}
      </Section>

      <Section icon={<Sparkles size={14} />} title={t('boot.copy.title')} hint={t('boot.copy.hint')}>
        <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr', gap: 8, alignItems: 'center' }}>
          <label htmlFor="splash-title" style={{ fontSize: 12, opacity: 0.75 }}>{t('boot.copy.titleLabel')}</label>
          <input
            id="splash-title"
            type="text"
            value={cfg.title}
            onChange={(e) => update({ title: e.target.value })}
            placeholder={DEFAULT_SPLASH.title}
            style={inputStyle}
          />
          <label htmlFor="splash-sub" style={{ fontSize: 12, opacity: 0.75 }}>{t('boot.copy.subtitleLabel')}</label>
          <input
            id="splash-sub"
            type="text"
            value={cfg.subtitle}
            onChange={(e) => update({ subtitle: e.target.value })}
            placeholder={DEFAULT_SPLASH.subtitle}
            style={inputStyle}
          />
        </div>
      </Section>

      <Section icon={<Sparkles size={14} />} title={t('boot.components.title')} hint={t('boot.components.hint')}>
        <label style={toggleStyle}>
          <input
            type="checkbox"
            checked={cfg.showProgressBar}
            onChange={(e) => update({ showProgressBar: e.target.checked })}
          />
          <span>{t('boot.components.showProgressBar')}</span>
          <span style={{ opacity: 0.5, fontSize: 11, marginLeft: 8 }}>
            {t('boot.components.showProgressBarHint')}
          </span>
        </label>
        <label style={toggleStyle}>
          <input
            type="checkbox"
            checked={cfg.showBusInventory}
            onChange={(e) => update({ showBusInventory: e.target.checked })}
          />
          <span>{t('boot.components.showBusInventory')}</span>
          <span style={{ opacity: 0.5, fontSize: 11, marginLeft: 8 }}>
            {t('boot.components.showBusInventoryHint')}
          </span>
        </label>
      </Section>

      <Section icon={<RefreshCw size={14} />} title={t('boot.apply.title')}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="settings-edit-btn"
            onClick={() => window.location.reload()}
            title={t('boot.apply.reloadTooltip')}
          >
            <RefreshCw size={12} /> {t('boot.apply.reloadButton')}
          </button>
          <button
            type="button"
            className="settings-edit-btn"
            onClick={() => setCfg({ ...DEFAULT_SPLASH })}
            title={t('boot.apply.resetTooltip')}
          >
            {t('boot.apply.resetButton')}
          </button>
          <span style={{ fontSize: 11, opacity: 0.5, marginLeft: 'auto' }}>
            {t('boot.apply.apiHintBefore')} <code style={{ background: 'rgba(255,255,255,0.04)', padding: '1px 4px', borderRadius: 3 }}>/api/boot-splash</code> {t('boot.apply.apiHintAfter')}
          </span>
        </div>
      </Section>
    </>
  );
}

const inputStyle = {
  background: 'rgba(0,0,0,0.4)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 5,
  padding: '6px 9px',
  color: 'var(--text-primary)',
  fontSize: 12,
  fontFamily: 'inherit',
  outline: 'none',
} as const;

const toggleStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 0',
  fontSize: 12,
  cursor: 'pointer',
} as const;
