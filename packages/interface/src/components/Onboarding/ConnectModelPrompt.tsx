// ConnectModelPrompt — the first-chat interceptor (design §11). Mounted once at
// the app root; dormant until the chat composer fires APP_EVENTS.openConnectPrompt
// because a send had no usable model path (see lib/model-route/checkModelReady).
//
// It offers the two connectable sources, framed as "connect to send the message
// you just typed":
//   API Key  → deep-link into Settings › Providers (user pastes a key there).
//   Local CLI→ deep-link into Settings › Providers.
//
// Kept intentionally thin: it does not itself send — the composer that opened it
// owns the pending text and the resume.

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '@/i18n';
import { useShellStore } from '../../store';
import { APP_EVENTS } from '../../lib/storageKeys';
import './Onboarding.css';

export function ConnectModelPrompt() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const openOverlay = useShellStore((s) => s.openOverlay);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(APP_EVENTS.openConnectPrompt, onOpen);
    return () => window.removeEventListener(APP_EVENTS.openConnectPrompt, onOpen);
  }, []);

  const gotoProviders = useCallback(() => {
    setOpen(false);
    openOverlay('settings', 'providers');
  }, [openOverlay]);

  if (!open) return null;

  return (
    <div
      className="fx-ob-modal-scrim"
      style={{ zIndex: 99998 }}
      onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
    >
      <div className="fx-ob-modal" role="dialog" aria-modal="true">
        <div className="fx-ob-modal-inner">
          <div className="fx-ob-stack fx-ob-gap6">
            <h2 className="fx-ob-h2">{t('onboarding.nudge.connectTitle')}</h2>
            <div className="fx-ob-sec">{t('onboarding.nudge.connectSub')}</div>
          </div>
          <div className="fx-ob-stack fx-ob-gap8">
            <button className="fx-ob-btn fx-ob-btn-primary fx-ob-btn-block" onClick={gotoProviders}>
              {t('onboarding.nudge.connectKey')}
            </button>
            <button className="fx-ob-btn fx-ob-btn-secondary fx-ob-btn-block" onClick={gotoProviders}>
              {t('onboarding.nudge.connectCli')}
            </button>
          </div>
          <div className="fx-ob-row" style={{ justifyContent: 'center' }}>
            <button className="fx-ob-btn fx-ob-btn-ghost" onClick={() => setOpen(false)}>
              {t('onboarding.nudge.connectCancel')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
