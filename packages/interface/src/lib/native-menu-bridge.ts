/** native-menu-bridge —— Tauri 原生菜单桥 (T5).
 *
 *  角色:把 web 端 menu-registry 的 SSOT 快照喂给原生菜单栏,把原生点击回吐给
 *  command bus。**两个方向都在这里**,让 Rust 侧完全不碰业务逻辑 (Rust 只做:
 *  JSON → Menu / id → emit)。压缩公理:菜单栏一处真源,web/native 都由它派生。
 *
 *  典型时序:
 *    1. 应用启动完成、boot 完毕后,App.tsx 调 `initNativeMenuBridge(...)`;
 *    2. 桥内:
 *         a. serializeMenusForNative(t)  取全量菜单契约
 *         b. 顶层塞 title = t('menubar.<menu>')  Rust 不做 i18n
 *         c. invoke('set_app_menu', { payload })  Rust 建 Menu 并挂到 app
 *         d. listen('menu:invoke', ...)          原生点击 → command bus
 *         e. onMenuChange(rebuild)               后续注册表变 → 重新 push
 *    3. 浏览器形态 (isTauri()===false) 全 no-op,零回归。
 *
 *  ⚠️ Rust 侧收到的 payload 结构与 menu-registry.ts 的 `NativeMenu` 一致,
 *  但额外带一个可选 `title` —— 我们在这里补上,契约扩展在桥内闭环,不动 T1。
 */

import { isTauri } from './platform/runtime';
import {
  onMenuChange,
  serializeMenusForNative,
  snapshotAllMenus,
  type MenuId,
  type MenuItemDef,
  type NativeMenu,
} from './menu-registry';

// ─── Types ────────────────────────────────────────────────────────────────

/** 派发接口:与 host.commands.execute 兼容,fire-and-forget。 */
export type MenuExecute = (id: string, args?: unknown) => void | Promise<unknown>;

export interface InitNativeMenuBridgeOptions {
  /** 命令派发器 —— 通常是 (id, args) => host.commands.execute(id, args)。 */
  execute: MenuExecute;
  /** i18n 翻译器 —— 通常是 useTranslation().t。 */
  translate: (key: string) => string;
}

/** Rust 侧 NativeMenuJson 的对应契约:menu-registry 的 NativeMenu + 顶层 title。
 *  只有此文件构造该形状;Rust 用 `#[serde(default)]` 允许 title 缺省 (只是防御)。 */
interface NativeMenuWithTitle extends NativeMenu {
  /** 已翻译的顶层菜单标题,例:'File' / '文件'。 */
  title: string;
}

// ─── Menu id → command lookup (原生点击回吐用) ─────────────────────────────

/** 展平所有菜单项 (含 children),建 id → def 的索引,供 menu:invoke 回吐时 O(1)
 *  查表。不缓存:每次点击都 fresh 一遍,让 when/enabled 变化立刻生效;菜单量级
 *  几十项,遍历开销可忽略。 */
function findMenuItemById(id: string): MenuItemDef | undefined {
  const all = snapshotAllMenus();
  for (const menuId of Object.keys(all) as MenuId[]) {
    const found = findInList(all[menuId], id);
    if (found) return found;
  }
  return undefined;
}

function findInList(list: readonly MenuItemDef[], id: string): MenuItemDef | undefined {
  for (const item of list) {
    if (item.id === id) return item;
    if (item.children && item.children.length > 0) {
      const nested = findInList(item.children, id);
      if (nested) return nested;
    }
  }
  return undefined;
}

// ─── Push (registry → native) ─────────────────────────────────────────────

/** 把当前注册表快照推给 Rust。失败时 warn 但不抛 —— 菜单更新失败不该让 boot
 *  炸掉;下次 onMenuChange 会重试。 */
async function pushMenusToNative(
  invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>,
  translate: (key: string) => string,
): Promise<void> {
  const raw = serializeMenusForNative(translate);
  // 补顶层 title —— 与 MenuBar.tsx 的 `t('menubar.${menu}')` 保持一致。
  const payload: NativeMenuWithTitle[] = raw.map((m) => ({
    ...m,
    title: translate(`menubar.${m.menu}`),
  }));
  try {
    await invoke('set_app_menu', { payload });
  } catch (err) {
    console.warn('[native-menu-bridge] set_app_menu failed:', (err as Error)?.message ?? err);
  }
}

// ─── Init (唯一对外入口) ────────────────────────────────────────────────

/** 幂等标记:StrictMode 双 invoke / boot 双路径都可能重入 init,原生只该被安装一次。
 *  一旦装上:后续调用直接返回。 */
let installed = false;

/** Public entry —— App.tsx 在 boot 完成后调用一次。返回 Promise 让调用方能
 *  await (不必须);浏览器形态立刻 resolve()。 */
export async function initNativeMenuBridge(opts: InitNativeMenuBridgeOptions): Promise<void> {
  if (!isTauri()) return; // web 形态 no-op
  if (installed) return;
  installed = true;

  const { execute, translate } = opts;

  // 懒加载 Tauri API —— 与 runtime.ts 的其它加载器同风格,避免把 chunk 塞进 web bundle。
  const [{ invoke }, eventMod] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('@tauri-apps/api/event'),
  ]);

  // 1. 首次推送 —— 让原生菜单栏与当前注册表对齐。
  await pushMenusToNative(invoke, translate);

  // 2. 注册表变动 —— 后续 register/unregister/when 切换都会触发 rebuild。
  //    在 change 时直接 fire-and-forget push;失败已在 pushMenusToNative 内吞。
  onMenuChange(() => {
    void pushMenusToNative(invoke, translate);
  });

  // 3. 原生点击回吐 —— Rust 侧 on_menu_event emit 'menu:invoke' { id },
  //    我们查注册表拿到 commandId + args,派发到 command bus。
  await eventMod.listen<{ id: string }>('menu:invoke', (ev) => {
    const id = ev.payload?.id;
    if (!id) return;
    const def = findMenuItemById(id);
    if (!def) {
      // 原生菜单栏比 web 快照晚一拍时可能出现;下次 push 会对齐。
      console.warn('[native-menu-bridge] menu:invoke for unknown id:', id);
      return;
    }
    if (!def.commandId) return; // 纯文本占位项,无命令。
    void execute(def.commandId, def.args);
  });
}
