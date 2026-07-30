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
import { warmRecentGames } from './recent-games';
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
    // Recurse into static children AND dynamic ones — a native click on a
    // dynamically-derived row (e.g. a recent game under 打开最近) must resolve
    // to its def so its commandId + args get dispatched. dynamicChildren is
    // re-derived here (cache current at click time), matching what was pushed.
    const kids = item.children && item.children.length > 0
      ? item.children
      : item.dynamicChildren
        ? item.dynamicChildren()
        : null;
    if (kids && kids.length > 0) {
      const nested = findInList(kids, id);
      if (nested) return nested;
    }
  }
  return undefined;
}

// ─── Trace (定位链路用) ───────────────────────────────────────────────────

/** Rust 侧 `fx_trace` 的句柄,init 拿到 invoke 后装上。 */
let traceSink: ((line: string) => void) | null = null;

/** 打一条链路追踪。同时走 console 和 Rust stderr —— release 的 .app 关掉了
 *  tauri 的 `devtools` feature,webview console 在那里够不着,只有转发到
 *  Rust 才能和 on_menu_event / set_app_menu 的日志汇在同一个流里比对时序。
 *
 *  导出给链路下游(命令落地后的 UI 环节)复用,让"事件没到"与"命令跑了但界面
 *  没出来"在同一个流里可区分。sink 未装上前只进 console。 */
export function fxTrace(line: string): void {
  console.debug('[fx-trace]', line);
  traceSink?.(line);
}

/** 模块内简称。 */
const trace = fxTrace;

// ─── Push (registry → native) ─────────────────────────────────────────────

/** 把当前注册表快照推给 Rust。失败时 warn 但不抛 —— 菜单更新失败不该让 boot
 *  炸掉;下次 onMenuChange 会重试。 */
async function pushMenusToNative(
  invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>,
  translate: (key: string) => string,
): Promise<void> {
  // Warm the recent-games cache so 打开最近's dynamicChildren serialize with a
  // current list. Web warms on File-dropdown open; native has no such hook, so
  // we warm here before every rebuild. Failures leave the last cache intact.
  trace('push: warmRecentGames…');
  await warmRecentGames();
  trace('push: warmRecentGames done, serializing…');
  const raw = serializeMenusForNative(translate);
  // 补顶层 title —— 与 MenuBar.tsx 的 `t('menubar.${menu}')` 保持一致。
  const payload: NativeMenuWithTitle[] = raw.map((m) => ({
    ...m,
    title: translate(`menubar.${m.menu}`),
  }));
  const fileIds = raw.find((m) => m.menu === 'file')?.items.map((i) => i.id) ?? [];
  trace(`push: serialized menus=${payload.length} file.items=[${fileIds.join(',')}]`);
  try {
    await invoke('set_app_menu', { payload });
    trace('push: set_app_menu resolved');
  } catch (err) {
    trace(`push: set_app_menu REJECTED ${(err as Error)?.message ?? String(err)}`);
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

  const { translate } = opts;

  // 懒加载 Tauri API —— 与 runtime.ts 的其它加载器同风格,避免把 chunk 塞进 web bundle。
  const [{ invoke }, eventMod] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('@tauri-apps/api/event'),
  ]);

  traceSink = (line) => { void invoke('fx_trace', { line }).catch(() => { /* 追踪不该反过来炸链路 */ }); };
  trace('init: tauri api loaded, starting first push…');

  // 1. 原生点击回吐 —— Rust 侧 on_menu_event emit 'menu:invoke' { id },
  //    我们查注册表拿到 commandId + args,派发到 command bus。
  //    先注册监听器再做首次 push:首次 push 会预热 listGames,若接口卡住,
  //    旧菜单仍能响应点击,不会出现"菜单显示但点击无反应"的窗口。
  await eventMod.listen<{ id: string }>('menu:invoke', (ev) => {
    const id = ev.payload?.id;
    trace(`recv: menu:invoke id=${String(id)}`);
    if (!id) return;
    const def = findMenuItemById(id);
    if (!def) {
      // 原生菜单栏比 web 快照晚一拍时可能出现;下次 push 会对齐。
      trace(`recv: id=${id} NOT FOUND in registry — dropped`);
      console.warn('[native-menu-bridge] menu:invoke for unknown id:', id);
      return;
    }
    if (!def.commandId) {
      trace(`recv: id=${id} has no commandId (placeholder) — dropped`);
      return; // 纯文本占位项,无命令。
    }
    trace(`dispatch: id=${id} → command '${def.commandId}' args=${JSON.stringify(def.args ?? null)}`);
    void Promise.resolve(opts.execute(def.commandId, def.args)).then(
      (r) => trace(`dispatch: '${def.commandId}' resolved ${JSON.stringify(r ?? null)}`),
      (e) => trace(`dispatch: '${def.commandId}' REJECTED ${(e as Error)?.message ?? String(e)}`),
    );
  });
  trace('init: menu:invoke listener registered — bridge live before first push');

  // 2. 注册表变动 —— 后续 register/unregister/when 切换都会触发 rebuild。
  //    在 change 时直接 fire-and-forget push;失败已在 pushMenusToNative 内吞。
  onMenuChange(() => {
    void pushMenusToNative(invoke, translate);
  });

  // 3. 首次推送 —— 让原生菜单栏与当前注册表对齐。
  await pushMenusToNative(invoke, translate);
  trace('init: first push returned');
}
