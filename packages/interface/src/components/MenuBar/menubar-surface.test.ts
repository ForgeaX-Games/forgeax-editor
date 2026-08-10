/** host.menubar 投影与解析器的钉子。
 *
 *  2026-08-06 外审点名:本文件(投影 + 解析器 + 新账本路径,265 行)此前**零测试**。
 *  这里钉住的是"AI 走人的路"这条主张在解析层的两个具体含义:
 *   - 人看不见的项,AI 也不能执行(`when()` 谓词必须两侧同口径);
 *   - 人看到的文字,就是 AI 拿到的文字(切语言后投影必须跟着变)。 */
import { describe, expect, test, afterEach } from 'bun:test';
import { projectMenuTree } from './menubar-surface';
import {
  registerMenuItem,
  snapshotAllMenus,
  __resetMenuRegistryForTest,
  type MenuItemDef,
} from '../../lib/menu-registry';

const t = ((key: string) => (key === 'menu.zh.only' ? '中文项' : key)) as never;

function item(def: Partial<MenuItemDef> & Pick<MenuItemDef, 'id' | 'menu' | 'labelKey'>): void {
  registerMenuItem({ group: 'test', order: 10, ...def } as MenuItemDef);
}

afterEach(() => { __resetMenuRegistryForTest(); });

describe('projectMenuTree —— 投影只放事实', () => {
  test('when() 为假的项不进投影(人看不见的东西不出现在 AI 的名录里)', () => {
    item({ id: 'edit.always', menu: 'edit', labelKey: 'always', commandId: 'cmd.always' });
    item({ id: 'edit.hidden', menu: 'edit', labelKey: 'hidden', commandId: 'cmd.hidden', when: () => false });

    const ids = (projectMenuTree(t).edit ?? []).map((node) => node.id);
    expect(ids).toContain('edit.always');
    expect(ids).not.toContain('edit.hidden');
  });

  test('投影带上 args —— 面板开关靠 args.id 才能被反查成"那扇门"', () => {
    // server 侧 `panel:` 解析失败时要在菜单树里按 app.panel.toggle 的 args.id 找回
    // 那扇活门(关着的面板不在 dock 里,但窗口菜单能开它)。args 不进投影,那条
    // 活路就断了,agent 只会告诉用户"这个面板不存在"。
    item({ id: 'window.outline', menu: 'window', labelKey: 'outline', commandId: 'app.panel.toggle', args: { id: 'ep:hierarchy' } });

    const node = (projectMenuTree(t).window ?? []).find((row) => row.id === 'window.outline');
    expect(node?.args).toEqual({ id: 'ep:hierarchy' });
  });

  test('投影的 label 跟着传入的 t 走 —— 切语言必须能产出不同的 snapshot', () => {
    item({ id: 'edit.zh', menu: 'edit', labelKey: 'menu.zh.only', commandId: 'c' });

    const zh = (projectMenuTree(t).edit ?? [])[0]?.label;
    const en = (projectMenuTree(((key: string) => (key === 'menu.zh.only' ? 'Chinese item' : key)) as never).edit ?? [])[0]?.label;

    expect(zh).toBe('中文项');
    expect(en).toBe('Chinese item');
    // 配套约束在 MenuBar.tsx:useMenubarSurface 的 effect 依赖必须是 `i18n.language`,
    // **不能**是 `t` —— i18n/index.ts 刻意让 `t` 的标识模块级恒定(免无限重渲染),
    // 拿它当依赖等于永不重投影:DOM 变英文、snapshot 仍中文,AI 按 label 导航与
    // 用户所见错位(2026-08-06 探测)。这里钉住"两种语言下投影确实不同"这个前提。
    expect(zh).not.toBe(en);
  });
});

describe('注册表快照 —— 解析器的事实来源', () => {
  test('隐藏项仍在注册表里,所以解析器必须自己查 when()', () => {
    item({ id: 'edit.hidden', menu: 'edit', labelKey: 'hidden', commandId: 'cmd.hidden', when: () => false });

    // snapshotAllMenus 是 resolveInvokable 的输入,它**不**过滤 when() —— 这正是
    // 解析器必须自查的原因:隐藏项在这里看得见,在屏幕上看不见。解析器不查的话,
    // 一个 snapshot 和 DOM 里都不存在的项仍可被 AI invoke 执行。
    const all = snapshotAllMenus();
    expect(all.edit.map((row) => row.id)).toContain('edit.hidden');
    expect((projectMenuTree(t).edit ?? []).map((row) => row.id)).not.toContain('edit.hidden');
  });
});
