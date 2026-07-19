/** a11y-summary —— ui_snapshot 的未注册区域兜底(P1-13,评审 三.2)。
 *
 *  组件库自带的 role / aria-label 是免维护的 W3C 语义源:注册表管「调得动」,本模块
 *  兜「看得见」——把 **不在 ActionRegistry 覆盖内** 的可见可交互元素汇成只读摘要,
 *  让 AI 至少能定位「界面上还有什么」,再由人渐进登记。只读定向辅助:这些元素
 *  **不能**经 ui_invoke 调用(契约 description 已写明)。
 */

export interface A11yEntry {
  role: string;
  label: string;
  disabled?: boolean;
}

const INTERACTIVE_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'select',
  'textarea',
  '[role="button"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="combobox"]',
].join(', ');

const MAX_ENTRIES = 120;

function roleOf(el: HTMLElement): string {
  return el.getAttribute('role') ?? el.tagName.toLowerCase();
}

function labelOf(el: HTMLElement): string {
  return (
    el.getAttribute('aria-label')?.trim() ||
    (el as HTMLInputElement).placeholder?.trim?.() ||
    el.getAttribute('title')?.trim() ||
    el.textContent?.trim().slice(0, 60) ||
    ''
  );
}

function isVisible(el: HTMLElement): boolean {
  // offsetParent 为 null 覆盖 display:none 与 fixed 之外的大多数隐藏;够用且便宜。
  return el.offsetParent !== null || el.tagName === 'BODY';
}

/** 汇总未注册区域的可交互元素(封顶 MAX_ENTRIES,超出标 truncated)。 */
export function buildA11ySummary(): { entries: A11yEntry[]; truncated: boolean } {
  if (typeof document === 'undefined') return { entries: [], truncated: false };
  const entries: A11yEntry[] = [];
  let truncated = false;
  const seen = new Set<string>();
  for (const el of document.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR)) {
    if (el.closest('[data-fx-action]')) continue; // 已在注册表覆盖内 → 归 actions,不重复
    if (!isVisible(el)) continue;
    const label = labelOf(el);
    if (!label) continue;
    const key = `${roleOf(el)}|${label}`;
    if (seen.has(key)) continue; // 同名同角色去重(列表行等重复元素只报一次)
    seen.add(key);
    if (entries.length >= MAX_ENTRIES) {
      truncated = true;
      break;
    }
    entries.push({
      role: roleOf(el),
      label,
      ...((el as HTMLButtonElement).disabled ? { disabled: true } : {}),
    });
  }
  return { entries, truncated };
}
