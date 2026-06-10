import { useState } from 'react';

// Dismissible controls cheat-sheet pinned to the bottom of the viewport. Lists
// the Blender-default camera + gizmo bindings. Closing it persists to
// localStorage (stays closed across sessions); a small "?" pill brings it back.
const KEY = 'forgeax:editor:hints-dismissed';

export function ViewportHints() {
  const [open, setOpen] = useState<boolean>(() => {
    try { return localStorage.getItem(KEY) !== '1'; } catch { return true; }
  });

  const dismiss = (): void => {
    setOpen(false);
    try { localStorage.setItem(KEY, '1'); } catch { /* storage off */ }
  };
  const reopen = (): void => {
    setOpen(true);
    try { localStorage.removeItem(KEY); } catch { /* storage off */ }
  };

  if (!open) {
    return (
      <button type="button" className="vp-hints-toggle" data-testid="viewport-hints-toggle"
        title="显示操作说明" onClick={reopen}>?</button>
    );
  }

  return (
    <div className="vp-hints" data-testid="viewport-hints">
      <div className="vp-hints-rows">
        <span className="vp-hints-row">
          <b>中键</b> 旋转 · <b>Shift+中键</b> 平移 · <b>Ctrl+中键 / 滚轮</b> 缩放 · <b>左键</b> 选择
        </span>
        <span className="vp-hints-row">
          <b>W / E / R</b> 移动·旋转·缩放 · <b>F</b> 聚焦选中 · 触控板 <b>Alt+左键</b> 旋转 · <b>⇧Alt</b> 平移
        </span>
      </div>
      <button type="button" className="vp-hints-close" data-testid="viewport-hints-close"
        title="关闭（点右下角 ? 可重新打开）" onClick={dismiss}>×</button>
    </div>
  );
}
