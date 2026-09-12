export function playFailureMessage(error: unknown, language: string): string {
  const detail = error && typeof error === 'object' ? error as { code?: unknown; hint?: unknown } : {};
  const zh = language === 'zh';
  return detail.code === 'render-system-no-camera'
    ? zh ? '暂时无法预览：游戏场景没有相机。请添加相机，或让 Agent 完成场景后再试。'
      : 'Cannot preview yet: the game scene has no camera. Add one or finish authoring the scene before trying Play.'
    : `${zh ? '预览未能启动' : 'Play could not start'}${typeof detail.hint === 'string' ? `: ${detail.hint}` : '.'}`;
}

/** A viewport-local notice survives disposal of a failed Play iframe. */
export function installPlayFailureNotice(container: HTMLElement, locale: () => string) {
  const notice = document.createElement('div');
  notice.setAttribute('role', 'status');
  notice.style.cssText = 'position:absolute;top:48px;left:8px;right:8px;z-index:20;display:none;'
    + 'align-items:center;gap:8px;padding:8px 10px;border-radius:6px;background:#302b22;color:#f0dec0;'
    + 'font:12px/1.4 system-ui;pointer-events:auto;';
  const text = document.createElement('span');
  text.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.style.cssText = 'border:0;background:transparent;color:inherit;cursor:pointer;font-size:18px;';
  const clear = () => { notice.style.display = 'none'; };
  close.addEventListener('click', clear);
  notice.append(text, close);
  container.append(notice);
  return {
    show(error: unknown) {
      const zh = locale() === 'zh';
      const message = playFailureMessage(error, locale());
      text.textContent = message;
      text.title = message;
      close.setAttribute('aria-label', zh ? '关闭预览提示' : 'Dismiss Play notice');
      notice.style.display = 'flex';
    },
    clear,
    dispose() { close.removeEventListener('click', clear); notice.remove(); },
  };
}
