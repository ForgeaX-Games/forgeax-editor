/** action-dom-discovery —— data-fx-action 声明式登记的**发现器**(评审 2.4)。
 *
 *  职责严格限定为「发现」:带 `data-fx-action="<id>"` 的元素挂载时自动
 *  `registerAction`(handler = click 该元素),**不构成第二条执行路径**——派发仍统一走
 *  action-registry 的 `dispatchAction` 单入口。目标元素不在 DOM(面板没开)时
 *  `available()` 返回人话原因 fail-closed;**不做自动导航**——「把面板打开」本身该是
 *  一个 action(如 workbench.open),导航编排属于模型,不藏进派发层。
 *
 *  可选注解:
 *    data-fx-title        人读标题(缺省取 aria-label / textContent)
 *    data-fx-description  AI 读说明
 *    data-fx-capability   权限分级(8 类之一;缺省 'other'。危险按钮**务必**标
 *                         delete/credential,编排层会据此弹确认卡)
 */
import { registerAction, type UiCapability } from './action-registry';

const VALID_CAPS: ReadonlySet<string> = new Set([
  'read', 'write', 'delete', 'exec', 'network', 'credential', 'delegate', 'other',
]);

/** id → 当前绑定的 DOM 元素(元素卸载后保留注册,available 报不可用;同 id 新元素挂载时重绑)。 */
const boundEls = new Map<string, HTMLElement>();
const registered = new Set<string>();

function titleFor(el: HTMLElement, id: string): string {
  return (
    el.dataset.fxTitle?.trim() ||
    el.getAttribute('aria-label')?.trim() ||
    el.textContent?.trim().slice(0, 60) ||
    id
  );
}

function bindElement(el: HTMLElement): void {
  const id = el.dataset.fxAction?.trim();
  if (!id) return;
  boundEls.set(id, el); // 同 id 新元素 → 重绑(注册项不变,available/run 经 map 取活引用)
  if (registered.has(id)) return;
  registered.add(id);
  const capRaw = el.dataset.fxCapability?.trim() ?? '';
  const capability = (VALID_CAPS.has(capRaw) ? capRaw : 'other') as UiCapability;
  registerAction({
    id,
    title: titleFor(el, id),
    description:
      el.dataset.fxDescription?.trim() ||
      `Click the "${titleFor(el, id)}" control (declared via data-fx-action).`,
    schema: { type: 'object', properties: {} },
    capability,
    surface: 'ui',
    available: () => {
      const cur = boundEls.get(id);
      return cur && cur.isConnected ? true : 'target element is not currently mounted (open its panel first)';
    },
    run: () => {
      const cur = boundEls.get(id);
      if (!cur || !cur.isConnected) {
        return { status: 'rejected' as const, reason: 'target element is not currently mounted' };
      }
      cur.click();
      return { status: 'completed' as const };
    },
  });
}

function scan(root: ParentNode): void {
  if (!(root instanceof Element) && !(root instanceof Document)) return;
  if (root instanceof Element && root.matches('[data-fx-action]')) bindElement(root as HTMLElement);
  for (const el of root.querySelectorAll<HTMLElement>('[data-fx-action]')) bindElement(el);
}

let started = false;

/** 启动发现器(幂等)。初扫全文档 + MutationObserver 增量。 */
export function startActionDomDiscovery(): void {
  if (started || typeof document === 'undefined') return;
  started = true;
  scan(document);
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (node instanceof Element) scan(node);
      }
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
}
