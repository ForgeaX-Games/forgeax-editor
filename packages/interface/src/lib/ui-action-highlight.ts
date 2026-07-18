/** ui-action-highlight —— AI 操作可视化(P1-11,ghost 高亮层)。
 *
 *  消费 action-registry 派发时发出的 `UI_ACTION_DISPATCH_EVENT`(source:'ai'):
 *    - 目标是 data-fx-action 绑定的元素 → 元素闪高亮(outline 脉冲);
 *    - 编程式 action(无对应元素)→ 右下角浮标「AI 正在:<title>」,自动淡出。
 *
 *  纯 DOM overlay,零 store 依赖,装不上(SSR)静默跳过;观测层绝不影响派发主流程。
 */
import { UI_ACTION_DISPATCH_EVENT, getAction } from './action-registry';

const STYLE_ID = 'fx-ui-action-highlight-style';
const BADGE_ID = 'fx-ui-action-badge';

const HIGHLIGHT_CSS = `
@keyframes fx-ai-pulse {
  0% { outline-color: rgba(99, 102, 241, 0.95); outline-offset: 1px; }
  100% { outline-color: rgba(99, 102, 241, 0); outline-offset: 6px; }
}
.fx-ai-highlight { outline: 2px solid rgba(99, 102, 241, 0.95); animation: fx-ai-pulse 1.2s ease-out 2; border-radius: 4px; }
#${BADGE_ID} {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
  background: rgba(30, 30, 46, 0.92); color: #e0e0ff; font-size: 12px;
  padding: 6px 10px; border-radius: 8px; border: 1px solid rgba(99, 102, 241, 0.6);
  pointer-events: none; transition: opacity 0.4s ease; opacity: 0;
}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = HIGHLIGHT_CSS;
  document.head.appendChild(style);
}

let badgeTimer: ReturnType<typeof setTimeout> | null = null;

function showBadge(text: string): void {
  let badge = document.getElementById(BADGE_ID);
  if (!badge) {
    badge = document.createElement('div');
    badge.id = BADGE_ID;
    document.body.appendChild(badge);
  }
  badge.textContent = text;
  badge.style.opacity = '1';
  if (badgeTimer) clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => {
    badge!.style.opacity = '0';
  }, 2_500);
}

function flashElement(el: HTMLElement): void {
  el.classList.remove('fx-ai-highlight');
  // 强制 reflow 让同元素连续两次派发都能重播动画。
  void el.offsetWidth;
  el.classList.add('fx-ai-highlight');
  setTimeout(() => el.classList.remove('fx-ai-highlight'), 2_600);
}

let installed = false;

/** bootUiBridge 调用一次(幂等)。 */
export function installUiActionHighlight(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  ensureStyle();
  window.addEventListener(UI_ACTION_DISPATCH_EVENT, (e) => {
    const detail = (e as CustomEvent).detail as { id?: string; source?: string } | undefined;
    if (!detail || detail.source !== 'ai' || !detail.id) return; // 人类操作不标注
    try {
      const el = document.querySelector<HTMLElement>(`[data-fx-action="${CSS_escape(detail.id)}"]`);
      const title = getAction(detail.id)?.title ?? detail.id;
      if (el && el.isConnected) flashElement(el);
      showBadge(`AI 正在:${title}`);
    } catch {
      /* 观测层绝不影响主流程 */
    }
  });
}

/** CSS.escape 兜底(老 WebView 可能缺)。 */
function CSS_escape(s: string): string {
  try {
    return CSS.escape(s);
  } catch {
    return s.replace(/["\\\]]/g, '\\$&');
  }
}
