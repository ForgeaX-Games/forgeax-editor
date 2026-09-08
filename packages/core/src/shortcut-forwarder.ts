/** Shortcut forwarding protocol shared with the Interface host receiver.
 *
 *  Editor Core owns the editor-family source. This module is exported through
 *  `@forgeax/editor-core/shortcut-forwarder` for Edit Runtime. Play Runtime
 *  cannot import Editor Core across the VAG boundary, so its zero-dependency
 *  copy must remain byte-for-byte behaviorally aligned with this file.
 *
 *  让全局快捷键(⌘K 命令面板 / Ctrl+Shift+* 布局键 / Esc)在 iframe 内也生效:studio 顶层的
 *  命令面板 + useGlobalShortcuts 拿不到跨 iframe 的按键,故各 iframe 内装本转发器,白名单命中
 *  → postMessage 给 parent;产品 host 校验 origin 后在顶层重放。Interface 是中间帧,
 *  转发器自带 relay,把 Runtime 子帧的按键逐层上抛到产品 host。
 *
 *  浏览器专用,零依赖。只传可序列化数据。
 */

/** postMessage 信封 type;与 Interface host 侧接收器共用。 */
export const FORGEAX_FORWARD_KEY = 'FORGEAX_FORWARD_KEY';

/** iframe → parent 转发的按键载荷(可序列化)。 */
export interface ForwardedKey {
  type: typeof FORGEAX_FORWARD_KEY;
  key: string;
  code: string;
  keyCode: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

// IME 组词中(中文拼音等)一律不转 —— 避免误吞输入。
function isComposing(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229 || e.key === 'Process';
}

function isForwardable(e: KeyboardEvent): boolean {
  if (isComposing(e)) return false;
  if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) return true;
  const mod = e.metaKey || e.ctrlKey; // macOS ⌘ 与 Ctrl 同义
  if (!mod) return false;
  if (e.shiftKey) return true; // Ctrl/⌘ + Shift + *(F/B/C/D/Enter/1/2/3)
  const k = e.key.toLowerCase();
  return k === 'k' || k === 'h' || k === ',' || k === '/' || e.code === 'Comma' || e.code === 'Slash';
}

function postUp(msg: ForwardedKey): void {
  try {
    if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
      window.parent.postMessage(msg, '*'); // 只发按键元信息,无内容 / 无凭据
    }
  } catch {
    /* ignore */
  }
}

/**
 * 在**当前 iframe** 内安装转发器。顶层帧是 no-op。返回卸载函数。
 * 中间帧(editor interface)同时 relay 子帧转来的按键、逐层上抛,自适应嵌套层级。
 */
let installed = false;

export function installShortcutForwarder(): () => void {
  if (typeof window === 'undefined' || window.parent === window) return () => {};
  // 幂等:同一帧只装一次(装两次会把每个键转两遍 → ⌘K 开了又关)。
  if (installed) return () => {};
  installed = true;

  const onKey = (e: KeyboardEvent): void => {
    if (!isForwardable(e)) return;
    postUp({
      type: FORGEAX_FORWARD_KEY,
      key: e.key,
      code: e.code,
      keyCode: e.keyCode,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
    });
  };

  const onMsg = (ev: MessageEvent): void => {
    const d = ev.data as Partial<ForwardedKey> | null;
    if (d && typeof d === 'object' && d.type === FORGEAX_FORWARD_KEY) postUp(d as ForwardedKey);
  };

  window.addEventListener('keydown', onKey, true);
  window.addEventListener('message', onMsg);
  return () => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('message', onMsg);
    installed = false;
  };
}
