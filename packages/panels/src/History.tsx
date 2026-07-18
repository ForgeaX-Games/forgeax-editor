import { gateway, useDocVersion } from '@forgeax/editor-core';
import { useTranslation } from '@forgeax/editor-core/i18n';

// History panel — the command timeline (design: AI Console / Undo history). Every
// mutation (human UI OR AI tool-call) is one EditorOp on the gateway, so this is
// a faithful "who did what" ledger. Click a step to time-travel (gateway.jumpTo);
// click an entity-bearing step to also select its target. Origin badge marks
// human vs AI — the editor's whole point is that both go through the same path.
export function HistoryPanel() {
  const { t } = useTranslation();
  useDocVersion(); // re-render on every gateway change
  const steps = gateway.historySteps();
  const head = gateway.appliedCount();

  return (
    <div className="panel" data-testid="panel-history">
      <h3>History</h3>
      <div className="hist-list" data-testid="hist-list">
        {steps.length === 0 ? (
          <div className="muted" style={{ padding: '4px 10px' }}>{t('editor.history.empty')}</div>
        ) : (
          steps.map((s, i) => (
            <div
              key={i}
              className={`hist-row${s.future ? ' future' : ''}${i + 1 === head ? ' head' : ''}`}
              data-testid={`hist-row-${i}`}
              title={t('editor.history.jumpToStep', { step: i + 1 })}
              onClick={() => {
                gateway.jumpTo(i + 1);
                if (typeof s.entity === 'number') gateway.dispatch({ kind: 'setSelection', id: s.entity });
              }}
            >
              <span className={`hist-origin ${s.origin}`} title={s.origin === 'ai' ? t('editor.history.originAi') : t('editor.history.originHuman')}>{s.origin === 'ai' ? '✦' : '·'}</span>
              <span className="hist-label">{s.label}</span>
              {typeof s.entity === 'number' && <span className="hist-ent">#{s.entity}</span>}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
