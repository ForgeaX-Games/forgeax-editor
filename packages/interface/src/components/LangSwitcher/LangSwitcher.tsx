import { useEffect, useRef, useState } from 'react';
import { Languages, Check } from 'lucide-react';
import { useTranslation } from '../../i18n';
import { useShellStore } from '../../store';
import './LangSwitcher.css';

/**
 * Agent reply-language switcher. Mounted in the Workbench "Agents · Team"
 * header (top-right). Controls the language the agent replies in.
 *
 * Semantics (see lib/reply-language.ts):
 *   - "Follow my input" (default ON, highest priority): the agent replies in the
 *     detected language of each user message.
 *   - Picking English / 中文 pins that language AND turns "follow input" OFF —
 *     an explicit manual choice wins (pinReplyLanguage).
 */
export function LangSwitcher({ className = '' }: { className?: string }) {
  const { t } = useTranslation();
  const replyLanguage = useShellStore((s) => s.replyLanguage);
  const followInput = useShellStore((s) => s.followInput);
  const pinReplyLanguage = useShellStore((s) => s.pinReplyLanguage);
  const setFollowInput = useShellStore((s) => s.setFollowInput);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const label = followInput ? t('lang.auto') : replyLanguage === 'zh' ? '中' : 'En';

  return (
    <div className={`lang-switcher ${className}`} ref={rootRef}>
      <button
        type="button"
        className={`lang-switcher-btn ${followInput ? '' : 'is-pinned'}`}
        onClick={() => setOpen((v) => !v)}
        title={t('lang.switcherTitle')}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Languages size={14} />
        <span className="lang-switcher-label">{label}</span>
      </button>
      {open && (
        <div className="lang-switcher-menu" role="menu">
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={followInput}
            className={`lang-switcher-item ${followInput ? 'is-current' : ''}`}
            onClick={() => { setFollowInput(true); setOpen(false); }}
          >
            <span className="lang-switcher-row">
              <span>{t('lang.followInput')}</span>
              {followInput && <Check size={13} />}
            </span>
            <span className="lang-switcher-desc">{t('lang.followInputDesc')}</span>
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!followInput && replyLanguage === 'en'}
            className={`lang-switcher-item ${!followInput && replyLanguage === 'en' ? 'is-current' : ''}`}
            onClick={() => { pinReplyLanguage('en'); setOpen(false); }}
          >
            <span className="lang-switcher-row">
              <span>English</span>
              {!followInput && replyLanguage === 'en' && <Check size={13} />}
            </span>
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!followInput && replyLanguage === 'zh'}
            className={`lang-switcher-item ${!followInput && replyLanguage === 'zh' ? 'is-current' : ''}`}
            onClick={() => { pinReplyLanguage('zh'); setOpen(false); }}
          >
            <span className="lang-switcher-row">
              <span>中文</span>
              {!followInput && replyLanguage === 'zh' && <Check size={13} />}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
