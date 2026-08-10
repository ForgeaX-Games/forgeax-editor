/** host.menubar —— 菜单栏的双模态投影(dual-modality UI surface)。
 *
 * 发布两样东西。**目前这是唯一一个真正接入 surface 总线的界面** —— host.sidebar(rail)
 * 至今没有发布者(见 docs/ai-native/pending-team-handoffs.md 的 H2),
 * 不要把它当成现成范式去抄。要抄就抄这里:
 *   1. snapshot = 菜单注册表的 JSON 安全树 —— AI 侧"静态功能表"的菜单分支。
 *      结构(含"打开最近"这类子菜单)是静态的;dynamic=true 的子菜单内容
 *      (最近游戏列表)在视觉展开时才求值,这个投影不展开它们。
 *   2. `invoke` action = 执行一个菜单项,走与人点击**完全相同**的
 *      `commands.execute(commandId, args)` —— MenuBar 的 onSelect 就是这一句。
 *      AI 路径与人路径在同一个 handler 汇合,这正是 dual-modality 的意义;
 *      也是页面外唯一正确的菜单执行入口(Radix 菜单项不响应合成 DOM 事件,
 *      2026-08-04 实测 click / pointer 序列 / focus+Enter 全部无效)。
 *
 * 语言:label 用页面自己的 t() 翻译,所以永远和用户看到的 DOM 文本一致 ——
 * 消费方按 label 做视觉遍历不会跨语言错位。
 */
import { useEffect, useRef } from 'react';
import type { TFunction } from '@/i18n';
import { useSurface } from '../../lib/surface';
import { snapshotAllMenus, type MenuItemDef } from '../../lib/menu-registry';
import { warmRecentGames } from '../../lib/recent-games';

export interface MenuTreeNode {
  id: string;
  label: string;
  /** command = 可执行叶子;submenu = 可展开;placeholder = 未接线的禁用占位。 */
  kind: 'command' | 'submenu' | 'placeholder';
  /** 叶子背后的命令 id —— 让"某个 catalog action 有没有可见的门"变成可对账的问题
   *  (ui_invoke 的返回体用它反查可见路径)。 */
  commandId?: string;
  keybinding?: string;
  /** 派发给 commands.execute 的参数 —— 等价性对账用(同 commandId 且同 args 才算同一能力)。 */
  args?: unknown;
  /** 子菜单内容在展开时运行时求值(如最近游戏列表)——树里只标不展。 */
  dynamic?: boolean;
  /** 动态子项共用的 commandId / 子项 id 构成规则 —— 见 MenuItemDef 同名字段。 */
  childCommandId?: string;
  childIdFromArg?: string;
  children?: MenuTreeNode[];
}

/** AI 路径的执行器**必须返回 promise**:run 会 await 它,命令失败 → throw →
 *  ack ok=false。人路径的 fire-and-forget 版本(不卡下拉动画)不在此签名内。 */
type Execute = (commandId: string, args?: unknown) => Promise<unknown>;

const MENUBAR_SCHEMA = {
  type: 'object',
  properties: {
    menus: {
      type: 'object',
      description: 'menu id → item tree. kind=submenu with dynamic=true resolves its children only when visually opened.',
    },
  },
} as const;

function projectItem(item: MenuItemDef, t: TFunction): MenuTreeNode | null {
  try {
    if (item.when && !item.when()) return null;
  } catch {
    return null; // 谓词抛异常按隐藏处理,投影永不因单项而炸
  }
  const isSub = (item.children?.length ?? 0) > 0 || !!item.dynamicChildren;
  const children = item.children
    ?.map((child) => projectItem(child, t))
    .filter((node): node is MenuTreeNode => node !== null);
  return {
    id: item.id,
    label: t(item.labelKey),
    kind: isSub ? 'submenu' : item.commandId ? 'command' : 'placeholder',
    ...(item.commandId ? { commandId: item.commandId } : {}),
    ...(item.args !== undefined ? { args: item.args } : {}),
    ...(item.keybinding ? { keybinding: item.keybinding } : {}),
    ...(item.dynamicChildren ? { dynamic: true } : {}),
    ...(item.dynamicChildCommandId ? { childCommandId: item.dynamicChildCommandId } : {}),
    ...(item.dynamicChildIdFromArg ? { childIdFromArg: item.dynamicChildIdFromArg } : {}),
    ...(children && children.length ? { children } : {}),
  };
}

export function projectMenuTree(t: TFunction): Record<string, MenuTreeNode[]> {
  const out: Record<string, MenuTreeNode[]> = {};
  for (const [menu, defs] of Object.entries(snapshotAllMenus())) {
    out[menu] = defs
      .map((def) => projectItem(def, t))
      .filter((node): node is MenuTreeNode => node !== null);
  }
  return out;
}

/** 在注册表里解析一个可执行菜单项:先静态(含 children 递归),再对动态子菜单
 *  求值按 id 或 label 匹配(动态项的 labelKey 就是显示名,如游戏名)。 */
function resolveInvokable(
  target: { itemId?: string; parentId?: string; label?: string },
  t: TFunction,
): MenuItemDef | null {
  /** 与 projectItem 同一条谓词:`when()` 为假 = 该项在界面上根本不存在。
   *  2026-08-06 探测:此前只有投影过滤 when(),解析器完全不看 —— 一个在 snapshot
   *  和 DOM 里都不存在的项仍可被 invoke 执行。人点不到的东西 AI 不能点,否则
   *  "AI 走人的路"这条主张在隐藏项上直接失效。当前 builtin 菜单无人用 `when:`,
   *  属于潜伏缺陷,但这是给别的团队照抄的模板,先堵上。 */
  const visible = (def: MenuItemDef): boolean => {
    try {
      return !def.when || def.when();
    } catch {
      return false; // 谓词抛异常按隐藏处理,与 projectItem 一致
    }
  };
  const matchDynamic = (parent: MenuItemDef): MenuItemDef | null => {
    if (!parent.dynamicChildren) return null;
    let kids: MenuItemDef[] = [];
    try {
      kids = parent.dynamicChildren();
    } catch {
      return null;
    }
    return kids.filter(visible).find((kid) =>
      (target.itemId && kid.id === target.itemId)
      || (target.label && (kid.labelKey === target.label || t(kid.labelKey) === target.label)),
    ) ?? null;
  };
  const walk = (defs: MenuItemDef[]): MenuItemDef | null => {
    for (const def of defs) {
      // 隐藏项(含其整棵子树)按"界面上不存在"处理,不匹配也不递归 —— 与
      // projectItem 的过滤同口径。
      if (!visible(def)) continue;
      if (target.itemId && def.id === target.itemId) return def;
      if (target.label && !target.itemId && t(def.labelKey) === target.label) return def;
      if (def.children) {
        const hit = walk(def.children);
        if (hit) return hit;
      }
      if (!target.parentId || def.id === target.parentId) {
        const hit = matchDynamic(def);
        if (hit) return hit;
      }
    }
    return null;
  };
  for (const defs of Object.values(snapshotAllMenus())) {
    const hit = walk(defs);
    if (hit) return hit;
  }
  return null;
}

/** MenuBar 挂载时注册 host.menubar。menusRevision 传注册表快照对象,引用一变
 *  (注册表变更触发的重渲染)就重新投影 PUT。 */
export function useMenubarSurface(
  menusRevision: unknown,
  t: TFunction,
  execute: Execute,
  /** 当前语言。**必须**由调用方传:`t` 的标识是模块级恒定的(见 i18n/index.ts
   *  的注释:列进依赖会造成无限重渲染),拿它当依赖 = 永不重投影。 */
  language?: string,
): void {
  const executeRef = useRef(execute);
  executeRef.current = execute;
  const tRef = useRef(t);
  tRef.current = t;

  const surface = useSurface({
    id: 'host.menubar',
    layer: 'host',
    schema: MENUBAR_SCHEMA as unknown as Record<string, unknown>,
    initialSnapshot: { menus: projectMenuTree(t) },
    actions: {
      invoke: {
        id: 'invoke',
        argsSchema: {
          type: 'object',
          properties: {
            itemId: { type: 'string', description: 'stable menu item id, e.g. file.save or file.openRecent.<slug>' },
            parentId: { type: 'string', description: 'submenu id to resolve dynamic children under, e.g. file.openRecent' },
            label: { type: 'string', description: 'visible label — used when the item is dynamic and its id is unknown' },
          },
        },
        run: async (raw) => {
          const target = (raw ?? {}) as { itemId?: string; parentId?: string; label?: string };
          let def = resolveInvokable(target, tRef.current);
          if (!def) {
            // 冷缓存(2026-08-06 外审 B6②):动态子项(最近游戏)只在人点开 File 下拉
            // 或 Tauri 原生菜单构建时被预热;web 模式下人没点过 File,dynamicChildren()
            // 恒空,AI 按 id/label 解析动态项必然 not found —— 桌面能用、web 不能用。
            // AI 先到时主动预热一次再重解析,与人"点开就看见"对齐。
            await warmRecentGames();
            def = resolveInvokable(target, tRef.current);
          }
          if (!def) throw new Error(`menu item not found: ${JSON.stringify(target)}`);
          const enabled = def.enabled ? def.enabled() : !!def.commandId;
          if (!enabled || !def.commandId) throw new Error(`menu item "${def.id}" is disabled or has no command wired`);
          // 2026-08-06 外审 B6①:此前不等命令完成就同步返回 —— 命令的异步失败对 agent
          // 不可见,file.save 失败也会被 ack 成功,agent 随即向用户断言"已保存"。
          // 人路径 fire-and-forget 有理由(不卡下拉动画),AI 路径没有:await 到底,
          // 失败 → throw → ack ok=false,agent 拿到真实回执。
          //
          // 但"启动后才失败"必须与上面两个"根本没启动"的 throw 区分开(2026-08-06
          // 自探):上游咽喉把 ack ok=false 一律当"确定没执行"→ 回落无头路径再派一次,
          // 于是写了一半就抛错的 file.save、后置步骤失败的新建游戏都会**跑两次**,
          // 而 agent 被告知"一次都没跑"。带上 started 标记,让消费方能作终态处理。
          try {
            await executeRef.current(def.commandId, def.args);
          } catch (error) {
            const started = new Error(
              `menu command "${def.commandId}" may have started but failed: ${(error as Error)?.message ?? String(error)}`
              + '(命令可能已经开始执行,不要重试、不要换路径重派。)',
            );
            // 语义是"**可能**已开始",不是"确定已开始":`commands.execute` 也可能在真正
            // 调用 handler 之前就 reject(commandId 声明了却从未注册等),界面这一侧
            // **区分不了**。所以这是个保守信号 —— 宁可让上游少做一次,也不能让它回落
            // 重派把同一命令跑两次。方向是刻意选的,别改成"确认执行过才标"。
            // 机器判据走 ack 的结构化字段,文案只给人看 —— 文案重排不再静默改变语义
            // (2026-08-07 外审 N3)。
            (started as Error & { started?: boolean }).started = true;
            throw started;
          }
          // 与人路径同形:两侧都给 { itemId, commandId }。`invoked` 是旧键,
          // 保留以免既有消费方(door 注解 / 行走协议的 steps)读空。
          return { itemId: def.id, commandId: def.commandId, invoked: def.id };
        },
      },
    },
  });

  useEffect(() => {
    surface.setSnapshot({ menus: projectMenuTree(tRef.current) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menusRevision, language]);
}
