import { bus, setSelection, useDocVersion } from '@forgeax/editor-edit-runtime';

// History panel — the command timeline (design: AI Console / Undo history). Every
// mutation (human UI OR AI tool-call) is one EditorCommand on the bus, so this is
// a faithful "who did what" ledger. Click a step to time-travel (bus.jumpTo);
// click an entity-bearing step to also select its target. Origin badge marks
// human vs AI — the editor's whole point is that both go through the same path.
export function HistoryPanel() {
  useDocVersion(); // re-render on every bus change
  const steps = bus.historySteps();
  const head = bus.appliedCount();

  return (
    <div className="panel" data-testid="panel-history">
      <h3>History</h3>
      <div className="hist-list" data-testid="hist-list">
        {steps.length === 0 ? (
          <div className="muted" style={{ padding: '4px 10px' }}>无操作</div>
        ) : (
          steps.map((s, i) => (
            <div
              key={i}
              className={`hist-row${s.future ? ' future' : ''}${i + 1 === head ? ' head' : ''}`}
              data-testid={`hist-row-${i}`}
              title={`跳转到第 ${i + 1} 步`}
              onClick={() => {
                bus.jumpTo(i + 1);
                if (typeof s.entity === 'number') setSelection(s.entity);
              }}
            >
              <span className={`hist-origin ${s.origin}`} title={s.origin === 'ai' ? 'AI' : '人'}>{s.origin === 'ai' ? '✦' : '·'}</span>
              <span className="hist-label">{s.label}</span>
              {typeof s.entity === 'number' && <span className="hist-ent">#{s.entity}</span>}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
