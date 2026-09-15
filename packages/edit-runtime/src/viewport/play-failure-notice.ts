import type { CommandError, DispatchResult } from '@forgeax/editor-core';

function failureDetail(error: unknown): { code?: unknown; hint: string } {
  const seen = new Set<object>();
  let value = error;
  let hint = '';
  let code: unknown;
  let source = '';
  for (let depth = 0; depth < 8 && value && typeof value === 'object' && !seen.has(value); depth += 1) {
    seen.add(value);
    const entry = value as Record<string, unknown>;
    if (typeof entry.code === 'string') code = entry.code;
    if (typeof entry.hint === 'string' && entry.hint.trim()) hint = entry.hint;
    else if (typeof entry.message === 'string' && entry.message.trim()) hint = entry.message;
    const detail = entry.detail && typeof entry.detail === 'object' ? entry.detail as Record<string, unknown> : undefined;
    if (typeof detail?.sourcePath === 'string') source = detail.sourcePath;
    if (typeof detail?.propertyPath === 'string') source += `${source ? ' · ' : ''}${detail.propertyPath}`;
    value = entry.cause;
  }
  if (!hint && typeof error === 'string') hint = error;
  return { code, hint: [source, hint].filter(Boolean).join(': ') };
}

export function playFailureMessage(error: unknown, language: string): string {
  const detail = failureDetail(error);
  const zh = language === 'zh';
  return detail.code === 'render-system-no-camera'
    ? zh ? '暂时无法预览：游戏场景没有相机。请添加相机，或让 Agent 完成场景后再试。'
      : 'Cannot preview yet: the game scene has no camera. Add one or finish authoring the scene before trying Play.'
    : `${zh ? '预览未能启动' : 'Play could not start'}${detail.hint ? `: ${detail.hint}` : '.'}`;
}

/** Preparation and failed session bootstrap precede the Play lifecycle hook. */
export function createPlayFailureReporter(deps: {
  fail(error: CommandError): void;
  notice: { show(error: unknown): void };
}) {
  return (cause: unknown): DispatchResult => {
    const error: CommandError = {
      code: 'play-assemble-failed',
      hint: failureDetail(cause).hint || 'Play startup is unavailable.',
      details: cause,
      cause: {
        code: typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string'
          ? cause.code : 'play-bootstrap-failed',
        hint: failureDetail(cause).hint || 'Play startup is unavailable.',
        details: cause,
      },
    };
    deps.fail(error);
    deps.notice.show(cause);
    return { ok: false, error };
  };
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
