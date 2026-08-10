/** host.menubar 的 invoke 执行器 —— "命令可能已经开始执行"这个信号的**产地**。
 *
 *  2026-08-07 外审 N3:这个信号此前只活在中文错误文案的子串里,改一句话就静默失效,
 *  而且没有任何测试会红。现在它是挂在 Error 上的结构化标记,由 ack 传给上游。
 *  上游拿它决定「失败后能不能回落原路重派」—— 判错的后果是**同一个命令跑两次**。
 *
 *  这里钉两条:该发的时候发,不该发的时候绝不滥发。
 *  (同目录的 menubar-surface.test.ts 只覆盖投影;解析器与 run 此前零覆盖。)
 */
import { describe, expect, test, afterEach, mock } from 'bun:test';
import { renderHook } from '@testing-library/react';
import {
  registerMenuItem,
  __resetMenuRegistryForTest,
  type MenuItemDef,
} from '../../lib/menu-registry';

/** useSurface 是注册副作用、且 useMenubarSurface 返回 void —— 从注册入参里截获
 *  真实的 invoke.run,避免为了测试去改生产接口。 */
type InvokeRun = (raw: { itemId?: string; parentId?: string; label?: string }) => Promise<unknown>;
let captured: InvokeRun | undefined;

mock.module('../../lib/surface', () => ({
  useSurface(input: { actions?: { invoke?: { run?: InvokeRun } } }) {
    captured = input.actions?.invoke?.run;
    // hook 随后会调 surface.setSnapshot(投影刷新)。桩必须给出这个形状 —— 返回
    // undefined 会让挂载时的 useEffect 直接炸,而那与本用例要钉的东西无关。
    return { setSnapshot: () => {} };
  },
}));

const { useMenubarSurface } = await import('./menubar-surface');

const t = ((key: string) => key) as never;

function item(def: Partial<MenuItemDef> & Pick<MenuItemDef, 'id' | 'menu' | 'labelKey'>): void {
  registerMenuItem({ group: 'test', order: 10, ...def } as MenuItemDef);
}

/** hook 内部用了 useRef,必须在真实渲染上下文里跑(直接调函数体会 Invalid hook call)。
 *  用 renderHook 起一次渲染,从被 mock 的 useSurface 入参里截获真实的 invoke.run。 */
function invokeRunFor(execute: (commandId: string, args?: unknown) => Promise<unknown>): InvokeRun {
  captured = undefined;
  renderHook(() => useMenubarSurface({}, t, execute));
  if (!captured) throw new Error('host.menubar 的 invoke 没有被注册');
  return captured;
}

afterEach(() => { __resetMenuRegistryForTest(); captured = undefined; });

describe('invoke 的 started 标记', () => {
  test('命令跑起来之后才失败 → 必须带 started(否则上游回落重派,同一命令跑两次)', async () => {
    item({ id: 'file.save', menu: 'file', labelKey: 'save', commandId: 'file.save' });
    const run = invokeRunFor(async () => { throw new Error('disk full'); });

    let thrown: unknown;
    try { await run({ itemId: 'file.save' }); } catch (e) { thrown = e; }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error & { started?: boolean }).started).toBe(true);
  });

  test('菜单项根本不存在 → 绝不能带 started(它的作用是禁止重试,滥发就是白白少做一次)', async () => {
    item({ id: 'file.save', menu: 'file', labelKey: 'save', commandId: 'file.save' });
    let calls = 0;
    const run = invokeRunFor(async () => { calls += 1; });

    let thrown: unknown;
    try { await run({ itemId: '__does_not_exist__' }); } catch (e) { thrown = e; }

    expect(thrown).toBeInstanceOf(Error);
    expect(Object.prototype.hasOwnProperty.call(thrown as object, 'started')).toBe(false);
    expect(calls).toBe(0); // 根本没走到 execute
  });

  test('项存在但没接命令 → 同样不带 started(也没启动过)', async () => {
    item({ id: 'file.todo', menu: 'file', labelKey: 'todo' }); // 无 commandId
    let calls = 0;
    const run = invokeRunFor(async () => { calls += 1; });

    let thrown: unknown;
    try { await run({ itemId: 'file.todo' }); } catch (e) { thrown = e; }

    expect(Object.prototype.hasOwnProperty.call(thrown as object, 'started')).toBe(false);
    expect(calls).toBe(0);
  });
});
