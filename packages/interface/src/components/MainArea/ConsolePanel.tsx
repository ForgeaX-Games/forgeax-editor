import { useAppStore } from '../../store';

// ConsolePanel — a standalone dock panel for the engine/editor console stream
// (the same `consoleLog` the Workbench bottom tab shows, surfaced as its own
// dockable/floatable/pop-out-able panel). Reuses the existing console-row styles.
export function ConsolePanel() {
  const consoleLog = useAppStore((s) => s.consoleLog);
  const clearConsole = useAppStore((s) => s.clearConsole);
  return (
    <div className="fx-console-panel">
      <div className="fx-console-bar">
        <span className="fx-console-title">Console{consoleLog.length ? ` · ${consoleLog.length}` : ''}</span>
        {consoleLog.length > 0 && (
          <button type="button" className="fx-console-clear" onClick={() => clearConsole()} title="清空 console">clear</button>
        )}
      </div>
      <div className="wb-bottom-body thin-scrollbar fx-console-body">
        {consoleLog.length === 0 && (
          <div className="wbb-row" style={{ opacity: 0.5 }}>
            <span>暂无 console 输出 — 游戏/编辑器的 console.log·warn·error 会实时显示</span>
          </div>
        )}
        {consoleLog.map((e, i) => {
          const d = new Date(e.ts);
          const stamp = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
          return (
            <div key={i} className={`wbb-row console-row level-${e.level}`}>
              <span className="wbb-time">{stamp}</span>
              <span className={`wbb-tag console-${e.level}`}>{e.level}</span>
              <span className="console-text">{e.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
