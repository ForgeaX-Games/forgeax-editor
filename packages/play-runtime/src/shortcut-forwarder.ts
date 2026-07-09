/** shortcut-forwarder —— VENDORED copy of `@forgeax/editor-core/src/shortcut-forwarder.ts`
 *  (itself a MIRROR of studio 权威 `@forgeax/host-sdk/src/shortcut-forwarder.ts`).
 *
 *  ⚠ play-runtime 经 VAG_* iframe 协议与 core 通信,**禁止**运行时 import `@forgeax/editor-core`
 *  (invariant #5 / `lint-play-vag-boundary`)。转发器是浏览器基础设施、零依赖,故这里 vendor
 *  一份本地副本而非跨包 import。改动请先改权威(host-sdk),再同步 editor-core 与本文件。
 *
 *  让全局快捷键(⌘K 命令面板 / Ctrl+Shift+* 布局键 / Esc)在 iframe 内也生效:studio 顶层的
 *  命令面板 + useGlobalShortcuts 拿不到跨 iframe 的按键,故各 iframe 内装本转发器,白名单命中
 *  → postMessage 给 parent;studio host 校验 origin 后在顶层重放。
 *
 *  浏览器专用,零依赖。只传可序列化数据。
 */

/** postMessage 信封 type;与 studio host 侧接收器共用。 */
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

/** 白名单:镜像 studio interface `global-shortcuts.ts` + CommandPalette 的 ⌘K。
 *  只转这些,普通输入 & 编辑键(Ctrl+C/V/X/A/Z…)不转,不干扰 iframe 内的编辑。 */
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
 * 中间帧同时 relay 子帧转来的按键、逐层上抛,自适应嵌套层级。
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
