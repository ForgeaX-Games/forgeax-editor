/** menu-registry —— 顶部菜单栏的单一真值源 (SSOT for the menu bar).
 *
 *  一张注册表服务两个消费者 (压缩公理:消掉「Web 菜单和原生菜单是不是同一套?」):
 *    1. Web 端渲染器 (React) —— 通过 `snapshotMenu(...)` / `snapshotAllMenus()` + `onMenuChange`
 *       走 useSyncExternalStore 拿到当前菜单结构;
 *    2. Tauri 原生菜单桥接 —— 通过 `serializeMenusForNative(t)` 拿到已翻译、去函数、
 *       JSON 可序列化的原生菜单契约,一次性 build native menu / 每次注册表变化时 rebuild.
 *
 *  设计与 action-registry.ts 对齐 (模块级 Map 页级单例 + change listener):
 *    - 菜单项按 `menu`(顶层大类) + `group`(段落分组) + `order`(段内序) 三级组织;
 *    - 同 id 重复注册 = **替换** (幂等,HMR / StrictMode 双挂载安全,cleanup
 *      走身份检查避免误删);
 *    - 键位串遵循全仓 canonical combo 格式 (见 lib/global-shortcuts.ts `prettyCombo`),
 *      例:'Ctrl+S' / 'Ctrl+Shift+Z' / 'Ctrl+,'。Web 显示走 prettyCombo,原生菜单走
 *      `serializeMenusForNative` 内部的 accelerator 转换 (Ctrl→CmdOrCtrl,保留 Shift/Alt)。
 *
 *  分隔符策略 (评审):**注册者不显式发 separator sentinel** —— 只填 `group`,
 *  渲染器按 `snapshotMenu` 返回结果中相邻两项的 `group` 差异自行绘制分隔线;
 *  原生序列化则在 `serializeMenusForNative` 中把段边界翻成 `separatorBefore=true`。
 *  这样避免维护「三种分隔来源」(注册者手插 + 渲染器 + 原生桥)—— 一处派生 (§2 Derive)。
 */

/** 菜单顶层大类。品牌菜单 (brand) 在 macOS 原生菜单里通常对应 app 菜单,由 T5 决定放置策略。 */
export type MenuId = 'brand' | 'file' | 'edit' | 'window' | 'build' | 'select' | 'help' | 'publish';

export interface MenuItemDef {
  /** 稳定唯一 id,例:'file.save' / 'window.toggle_chat'。重复注册会抛错。 */
  id: string;
  /** 归属菜单顶层大类。 */
  menu: MenuId;
  /** 分组键 —— 菜单内的段落分组;渲染器/原生桥根据相邻项的 group 差异插入分隔符。 */
  group: string;
  /** 段内排序 (升序)。同 order 用插入顺序破平局 (稳定排序)。 */
  order: number;
  /** i18n key —— 渲染时经 `t(labelKey)` 翻译;`serializeMenusForNative` 由调用方
   *  传入的 `translate` fn 完成翻译,进而不把函数塞进原生契约。 */
  labelKey: string;
  /** lucide 图标名 (仅 Web 端渲染;原生菜单不带 icon)。 */
  icon?: string;
  /** 要执行的 command bus id;省略 = 该项为**纯文本禁用项** (占位/说明/未来功能)。 */
  commandId?: string;
  /** 派发命令时透传给 `commands.execute(commandId, args)` 的参数。 */
  args?: unknown;
  /** 键位组合 (canonical),例:'Ctrl+S'。Web 用 prettyCombo 显示,原生转为 accelerator。 */
  keybinding?: string;
  /** 可见性谓词 —— 返回 false 时该项从菜单中**隐藏** (原生序列化时直接 drop)。 */
  when?: () => boolean;
  /** 显式启用谓词 —— 缺省时默认为 `!!commandId` (无命令则不可点)。 */
  enabled?: () => boolean;
  /** 复选态谓词 (Window 面板 toggle 类)。 */
  checked?: () => boolean;
  /** 危险/破坏性样式标记 (仅 Web 视觉;原生透传但由平台决定是否使用)。 */
  danger?: boolean;
  /** 子菜单 (例:File → Open Recent → ...;Select → By Type → ...)。 */
  children?: MenuItemDef[];
  /** 动态子菜单派生器 —— 渲染器在 submenu 展开时同步求值,返回运行时派生的子项
   *  (例:File → 打开最近 → 按 mtime 排序的最近游戏列表)。与静态 `children`
   *  互斥优先:声明了本项即视为可展开的 submenu,展开时才求值 (SSOT 仍是注册表,
   *  子项是纯 derive)。求值必须同步 (数据源需在展开前预取/缓存);仅 Web 端消费,
   *  原生序列化不含动态子项 (native 菜单结构在 build 时固化)。 */
  dynamicChildren?: () => MenuItemDef[];
}

// ─── 注册表本体 (模块级 Map,页级单例) ────────────────────────────────────────

const items = new Map<string, MenuItemDef>();
const changeListeners = new Set<() => void>();

function notifyChange(): void {
  for (const cb of changeListeners) {
    try {
      cb();
    } catch {
      /* listener 异常不传染 */
    }
  }
}

/** 注册一项菜单 —— 同 id 重复注册 = 替换 (幂等,HMR / StrictMode 双挂载安全)。
 *  返回 cleanup 函数;cleanup 幂等 (身份检查:仅当当前项仍是本次注册的 def
 *  才 delete,避免 A 注册→A 注销 后误删掉 B 的 same-id 覆盖)。
 *
 *  设计变更 (T7 集成):初版为 throw-on-duplicate,与 action-registry 的
 *  「替换即幂等」策略不一致 —— React StrictMode 会双执行 App.tsx 的
 *  bootstrapAppHost useEffect,两次 setup 并发跑到同一个模块级 Map 时必抛
 *  「duplicate menu item id」把整个菜单栏打空。改为 last-writer-wins 后
 *  两次 setup 都能顺利完成,先释放的 cleanup 通过身份检查不会误删,
 *  与 action-registry 的语义对齐 (§SSOT / 兄弟注册表一致性)。 */
export function registerMenuItem(def: MenuItemDef): () => void {
  items.set(def.id, def);
  notifyChange();
  return () => {
    if (items.get(def.id) === def) {
      items.delete(def.id);
      notifyChange();
    }
  };
}

/** 注册表变更订阅 —— 供 useSyncExternalStore / native bridge rebuild 消费。 */
export function onMenuChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

// ─── 派生视图:排序与快照 (SSOT 是 items Map;所有视图都是纯 derive) ─────────

/** 排序规则:先按 group 的**首次出现顺序**分段,段内按 order 升序 (相同 order 用
 *  插入顺序破平局,稳定排序)。JS `Array.prototype.sort` 从 ES2019 起要求稳定,
 *  Bun/V8/JSC 均已合规,直接用即可。 */
function sortMenuItems(list: MenuItemDef[]): MenuItemDef[] {
  const groupFirstIndex = new Map<string, number>();
  list.forEach((item, idx) => {
    if (!groupFirstIndex.has(item.group)) groupFirstIndex.set(item.group, idx);
  });
  const decorated = list.map((item, idx) => ({ item, idx }));
  decorated.sort((a, b) => {
    const ga = groupFirstIndex.get(a.item.group)!;
    const gb = groupFirstIndex.get(b.item.group)!;
    if (ga !== gb) return ga - gb;
    if (a.item.order !== b.item.order) return a.item.order - b.item.order;
    return a.idx - b.idx; // 稳定破平局:插入顺序
  });
  return decorated.map((d) => d.item);
}

/** 取单个菜单的排序后条目 —— 渲染器直接消费。 */
export function snapshotMenu(menu: MenuId): MenuItemDef[] {
  const list: MenuItemDef[] = [];
  for (const def of items.values()) {
    if (def.menu === menu) list.push(def);
  }
  return sortMenuItems(list);
}

const ALL_MENUS: readonly MenuId[] = ['brand', 'file', 'edit', 'window', 'build', 'select', 'help', 'publish'];

/** 取所有菜单的排序后条目,按 MenuId 组织。 */
export function snapshotAllMenus(): Record<MenuId, MenuItemDef[]> {
  const out = {} as Record<MenuId, MenuItemDef[]>;
  for (const m of ALL_MENUS) out[m] = snapshotMenu(m);
  return out;
}

// ─── 原生菜单序列化契约 (Tauri 桥消费;必须 JSON 可序列化) ─────────────────────

export interface NativeMenuItem {
  /** 对应 MenuItemDef.id。 */
  id: string;
  /** **已翻译**的显示文本 (调用方传入的 `translate` fn 完成)。 */
  label: string;
  /** 原生 accelerator 字符串,例:'CmdOrCtrl+S' / 'CmdOrCtrl+Shift+Z'。无键位则省略。 */
  accelerator?: string;
  /** 已解析的启用态 (when 已 drop 掉隐藏项;enabled 默认 = !!commandId)。 */
  enabled: boolean;
  /** 破坏性样式提示 (原样透传,由平台决定是否使用)。 */
  danger?: boolean;
  /** 当前项是**新段的第一项**时为 true (菜单内首项除外),原生桥据此插分隔符。 */
  separatorBefore?: boolean;
  /** 子菜单 (递归应用同样的翻译/序列化规则)。 */
  children?: NativeMenuItem[];
}

export interface NativeMenu {
  menu: MenuId;
  items: NativeMenuItem[];
}

/** 键位串 → 原生 accelerator 转换。canonical 形如 'Ctrl+Shift+S';原生形 'CmdOrCtrl+Shift+S'
 *  (Tauri/Electron 通用惯例:Ctrl 走 CmdOrCtrl,让 macOS 走 ⌘、其它平台走 Ctrl)。 */
function toNativeAccelerator(combo: string): string {
  return combo
    .split('+')
    .map((seg) => (seg === 'Ctrl' ? 'CmdOrCtrl' : seg))
    .join('+');
}

/** 递归序列化一项 (含 children) —— 返回值必须完全无函数,可直接 JSON.stringify。 */
function serializeItem(def: MenuItemDef, translate: (key: string) => string): NativeMenuItem | null {
  if (def.when && !def.when()) return null; // 隐藏项直接 drop
  // Static `children` OR a `dynamicChildren` derivation — both serialize the
  // same way. dynamicChildren is evaluated at serialize time (native menu is
  // rebuilt on every registry change, so it re-derives with the cache current
  // at that moment). Web + native thus share one derivation (§Derive / §SSOT).
  const childDefs = def.children && def.children.length > 0
    ? def.children
    : def.dynamicChildren
      ? def.dynamicChildren()
      : null;
  // enabled: explicit predicate wins; a submenu opener (has children) defaults
  // enabled even without a command; else `!!commandId`. Mirrors the web
  // renderer's resolveEnabled so both bars agree on which items are clickable.
  const enabledResolved = def.enabled
    ? def.enabled()
    : (childDefs && childDefs.length > 0)
      ? true
      : !!def.commandId;
  const out: NativeMenuItem = {
    id: def.id,
    label: translate(def.labelKey),
    enabled: enabledResolved,
  };
  if (def.keybinding) out.accelerator = toNativeAccelerator(def.keybinding);
  if (def.danger) out.danger = true;
  if (childDefs && childDefs.length > 0) {
    const kids: NativeMenuItem[] = [];
    for (const child of childDefs) {
      const ser = serializeItem(child, translate);
      if (ser) kids.push(ser);
    }
    if (kids.length > 0) out.children = kids;
  }
  return out;
}

/** 序列化全部菜单为原生契约 —— T5 (Tauri 桥) 的唯一入口。契约要点:
 *    - `when === false` 的项被 drop;
 *    - `enabled` 缺省时默认 = `!!commandId` (无命令 = 禁用);
 *    - `labelKey` 走 `translate` 翻译,函数不出墙;
 *    - `keybinding` 转 native accelerator (Ctrl→CmdOrCtrl,Shift/Alt 保留);
 *    - 段边界翻成 `separatorBefore=true` (每个菜单首项除外);
 *    - 输出**完全 JSON 可序列化** (JSON.stringify 无损 roundtrip,无函数残留)。 */
export function serializeMenusForNative(translate: (key: string) => string): NativeMenu[] {
  const out: NativeMenu[] = [];
  for (const menu of ALL_MENUS) {
    const sorted = snapshotMenu(menu);
    const serialized: NativeMenuItem[] = [];
    let prevGroup: string | null = null;
    for (const def of sorted) {
      const ser = serializeItem(def, translate);
      if (!ser) {
        // when=false 的项被 drop;下一项若换 group 依然按已见 group 判段边界。
        prevGroup = def.group;
        continue;
      }
      if (prevGroup !== null && def.group !== prevGroup) ser.separatorBefore = true;
      serialized.push(ser);
      prevGroup = def.group;
    }
    out.push({ menu, items: serialized });
  }
  return out;
}

// ─── 测试辅助 (生产代码不要调) ─────────────────────────────────────────────

/** 清空注册表 —— 仅供单测 beforeEach 使用。 */
export function __resetMenuRegistryForTest(): void {
  items.clear();
  changeListeners.clear();
}
