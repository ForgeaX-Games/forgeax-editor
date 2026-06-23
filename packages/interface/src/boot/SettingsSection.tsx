import { useMemo, type ReactNode } from 'react';
import { Sparkles, RefreshCw } from 'lucide-react';
import { Section } from '../components/TopBar/SettingsDrawer';
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
        title="主题"
        hint="开机动画风格 · 刷新生效"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {SPLASH_THEMES.map((t) => {
            const checked = t.id === cfg.theme;
            return (
              <label
                key={t.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: '8px 10px',
                  borderRadius: 6,
                  border: `1px solid ${checked ? t.swatch + '55' : 'rgba(255,255,255,0.06)'}`,
                  background: checked ? `${t.swatch}0d` : 'transparent',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="radio"
                  name="splash-theme"
                  checked={checked}
                  onChange={() => update({ theme: t.id as SplashThemeId })}
                  style={{ marginTop: 3, accentColor: t.swatch }}
                />
                <span
                  aria-hidden
                  style={{
                    width: 10, height: 10, borderRadius: '50%',
                    background: t.swatch,
                    boxShadow: `0 0 6px ${t.swatch}88`,
                    flexShrink: 0,
                    marginTop: 5,
                  }}
                />
                <span style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: checked ? t.swatch : 'var(--text-secondary)' }}>
                    {t.label}
                  </span>
                  <span style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>{t.desc}</span>
                </span>
              </label>
            );
          })}
        </div>
        {preview}
      </Section>

      <Section icon={<Sparkles size={14} />} title="文案" hint="标题 / 副标题 — 留空恢复默认">
        <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr', gap: 8, alignItems: 'center' }}>
          <label htmlFor="splash-title" style={{ fontSize: 12, opacity: 0.75 }}>标题</label>
          <input
            id="splash-title"
            type="text"
            value={cfg.title}
            onChange={(e) => update({ title: e.target.value })}
            placeholder={DEFAULT_SPLASH.title}
            style={inputStyle}
          />
          <label htmlFor="splash-sub" style={{ fontSize: 12, opacity: 0.75 }}>副标题</label>
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

      <Section icon={<Sparkles size={14} />} title="组件" hint="单独开关进度条 / bus 库存行">
        <label style={toggleStyle}>
          <input
            type="checkbox"
            checked={cfg.showProgressBar}
            onChange={(e) => update({ showProgressBar: e.target.checked })}
          />
          <span>显示进度条</span>
          <span style={{ opacity: 0.5, fontSize: 11, marginLeft: 8 }}>
            （React 启动进度 · 平时 ~1s 走完）
          </span>
        </label>
        <label style={toggleStyle}>
          <input
            type="checkbox"
            checked={cfg.showBusInventory}
            onChange={(e) => update({ showBusInventory: e.target.checked })}
          />
          <span>显示 bus 插件总数</span>
          <span style={{ opacity: 0.5, fontSize: 11, marginLeft: 8 }}>
            （拉一次 /api/bus/plugins · 调试用）
          </span>
        </label>
      </Section>

      <Section icon={<RefreshCw size={14} />} title="应用 / 重置">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="settings-edit-btn"
            onClick={() => window.location.reload()}
            title="刷新页面 · 让 splash 重新渲染"
          >
            <RefreshCw size={12} /> 应用并刷新预览
          </button>
          <button
            type="button"
            className="settings-edit-btn"
            onClick={() => setCfg({ ...DEFAULT_SPLASH })}
            title="恢复 classic-lime + 默认文案"
          >
            恢复默认
          </button>
          <span style={{ fontSize: 11, opacity: 0.5, marginLeft: 'auto' }}>
            AI 在 ChatPanel 也可以 POST <code style={{ background: 'rgba(255,255,255,0.04)', padding: '1px 4px', borderRadius: 3 }}>/api/boot-splash</code> 修改
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
