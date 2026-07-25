/** menu-registry 单测:注册 + 幂等 cleanup + 重复抛错、排序 (group 首现顺序 + order 内序)、
 *  change listener 触发时机、原生序列化契约 (when/enabled/accelerator/separatorBefore/JSON 可序列化)。 */
import { describe, expect, test, beforeEach } from 'bun:test';
import {
  registerMenuItem,
  snapshotMenu,
  snapshotAllMenus,
  onMenuChange,
  serializeMenusForNative,
  __resetMenuRegistryForTest,
  type MenuItemDef,
} from './menu-registry';

beforeEach(() => {
  __resetMenuRegistryForTest();
});

/** 简易 translate — 直接返回 `[key]` 便于断言键路径。 */
const t = (key: string): string => `[${key}]`;

describe('registerMenuItem — 注册 + cleanup + 重复抛错', () => {
  test('注册后 snapshotMenu 能看到;cleanup 会移除', () => {
    const cleanup = registerMenuItem({
      id: 'file.save',
      menu: 'file',
      group: 'io',
      order: 10,
      labelKey: 'menu.file.save',
      commandId: 'file.save',
    });
    expect(snapshotMenu('file').map((i) => i.id)).toEqual(['file.save']);
    cleanup();
    expect(snapshotMenu('file')).toEqual([]);
  });

  test('cleanup 幂等 —— 多次调用无副作用', () => {
    const cleanup = registerMenuItem({
      id: 'file.new',
      menu: 'file',
      group: 'io',
      order: 1,
      labelKey: 'menu.file.new',
      commandId: 'file.new',
    });
    cleanup();
    cleanup(); // 不应抛
    expect(snapshotMenu('file')).toEqual([]);
  });

  test('同 id 重复注册 → 替换 (HMR / StrictMode 双挂载幂等)', () => {
    // T7 集成收口:改为 last-writer-wins,与 action-registry 语义对齐。
    // React StrictMode 会双执行 bootstrapAppHost 的 useEffect,两次 setup
    // 并发注册到同一个模块级 Map;throw-on-duplicate 会把整个菜单栏打空。
    const cleanup1 = registerMenuItem({
      id: 'file.save',
      menu: 'file',
      group: 'io',
      order: 10,
      labelKey: 'l.old',
      commandId: 'file.save',
    });
    const cleanup2 = registerMenuItem({
      id: 'file.save',
      menu: 'file',
      group: 'io',
      order: 10,
      labelKey: 'l.new',
      commandId: 'file.save',
    });
    // 替换语义:第二次注册胜出,快照只有一条,label 为 l.new。
    expect(snapshotMenu('file').map((i) => ({ id: i.id, label: i.labelKey })))
      .toEqual([{ id: 'file.save', label: 'l.new' }]);
    // 身份检查 cleanup:先释放旧 cleanup 不应删掉当前项 (它已被替换),
    // 只有释放当前活跃 def 的 cleanup 才真正 delete。
    cleanup1();
    expect(snapshotMenu('file').map((i) => i.id)).toEqual(['file.save']);
    cleanup2();
    expect(snapshotMenu('file')).toEqual([]);
  });
});

describe('snapshotMenu — 排序:group 首现顺序 + order 内序', () => {
  test('段按 group 首次出现顺序,段内按 order 升序', () => {
    // 注册顺序:io(order=10)、meta(order=1)、io(order=5) —— 段序应为 io 在前 (先见),meta 在后。
    // 段内:io 有 order=10 和 5 → 排 5, 10;meta 只有 order=1 → 单独。
    registerMenuItem({
      id: 'file.save',
      menu: 'file',
      group: 'io',
      order: 10,
      labelKey: 'l.save',
      commandId: 'file.save',
    });
    registerMenuItem({
      id: 'file.close',
      menu: 'file',
      group: 'meta',
      order: 1,
      labelKey: 'l.close',
      commandId: 'file.close',
    });
    registerMenuItem({
      id: 'file.new',
      menu: 'file',
      group: 'io',
      order: 5,
      labelKey: 'l.new',
      commandId: 'file.new',
    });
    expect(snapshotMenu('file').map((i) => i.id)).toEqual(['file.new', 'file.save', 'file.close']);
  });

  test('snapshotAllMenus 返回全部 MenuId,空菜单为空数组', () => {
    registerMenuItem({
      id: 'help.about',
      menu: 'help',
      group: 'about',
      order: 1,
      labelKey: 'l.about',
      commandId: 'help.about',
    });
    const all = snapshotAllMenus();
    expect(all.help.map((i) => i.id)).toEqual(['help.about']);
    expect(all.file).toEqual([]);
    expect(all.edit).toEqual([]);
    expect(all.brand).toEqual([]);
    expect(all.window).toEqual([]);
    expect(all.build).toEqual([]);
    expect(all.select).toEqual([]);
    expect(all.publish).toEqual([]);
  });
});

describe('onMenuChange — 注册 / cleanup 均触发', () => {
  test('注册与 cleanup 都会触发 listener', () => {
    let fires = 0;
    const off = onMenuChange(() => {
      fires += 1;
    });
    const cleanup = registerMenuItem({
      id: 'file.save',
      menu: 'file',
      group: 'io',
      order: 10,
      labelKey: 'l.save',
      commandId: 'file.save',
    });
    expect(fires).toBe(1);
    cleanup();
    expect(fires).toBe(2);
    off();
    // 取消订阅后不再触发
    registerMenuItem({
      id: 'file.new',
      menu: 'file',
      group: 'io',
      order: 1,
      labelKey: 'l.new',
      commandId: 'file.new',
    });
    expect(fires).toBe(2);
  });
});

describe('serializeMenusForNative — 原生契约', () => {
  test('when === false 的项被 drop;enabled 缺省 = !!commandId', () => {
    // 三项:一项 when=false (隐藏)、一项有 commandId (启用)、一项无 commandId (禁用文本)。
    registerMenuItem({
      id: 'file.hidden',
      menu: 'file',
      group: 'io',
      order: 1,
      labelKey: 'l.hidden',
      commandId: 'file.hidden',
      when: () => false,
    });
    registerMenuItem({
      id: 'file.save',
      menu: 'file',
      group: 'io',
      order: 2,
      labelKey: 'l.save',
      commandId: 'file.save',
    });
    registerMenuItem({
      id: 'file.disabled_stub',
      menu: 'file',
      group: 'io',
      order: 3,
      labelKey: 'l.stub',
      // no commandId → enabled 默认 false
    });
    const native = serializeMenusForNative(t);
    const fileMenu = native.find((m) => m.menu === 'file')!;
    expect(fileMenu.items.map((i) => i.id)).toEqual(['file.save', 'file.disabled_stub']);
    expect(fileMenu.items.find((i) => i.id === 'file.save')!.enabled).toBe(true);
    expect(fileMenu.items.find((i) => i.id === 'file.disabled_stub')!.enabled).toBe(false);
  });

  test('段边界置 separatorBefore=true (菜单首项除外)', () => {
    registerMenuItem({
      id: 'edit.undo',
      menu: 'edit',
      group: 'history',
      order: 1,
      labelKey: 'l.undo',
      commandId: 'edit.undo',
    });
    registerMenuItem({
      id: 'edit.redo',
      menu: 'edit',
      group: 'history',
      order: 2,
      labelKey: 'l.redo',
      commandId: 'edit.redo',
    });
    registerMenuItem({
      id: 'edit.cut',
      menu: 'edit',
      group: 'clip',
      order: 1,
      labelKey: 'l.cut',
      commandId: 'edit.cut',
    });
    registerMenuItem({
      id: 'edit.copy',
      menu: 'edit',
      group: 'clip',
      order: 2,
      labelKey: 'l.copy',
      commandId: 'edit.copy',
    });
    const native = serializeMenusForNative(t);
    const editMenu = native.find((m) => m.menu === 'edit')!;
    // 顺序:undo(首项,无 separator) → redo(同段,无) → cut(新段,有) → copy(同段,无)
    expect(editMenu.items.map((i) => [i.id, i.separatorBefore ?? false])).toEqual([
      ['edit.undo', false],
      ['edit.redo', false],
      ['edit.cut', true],
      ['edit.copy', false],
    ]);
  });

  test('labels 走 translate;keybinding → accelerator (Ctrl → CmdOrCtrl,保留 Shift/Alt)', () => {
    registerMenuItem({
      id: 'file.save',
      menu: 'file',
      group: 'io',
      order: 1,
      labelKey: 'menu.file.save',
      commandId: 'file.save',
      keybinding: 'Ctrl+S',
    });
    registerMenuItem({
      id: 'edit.redo',
      menu: 'edit',
      group: 'history',
      order: 1,
      labelKey: 'menu.edit.redo',
      commandId: 'edit.redo',
      keybinding: 'Ctrl+Shift+Z',
    });
    registerMenuItem({
      id: 'window.alt_only',
      menu: 'window',
      group: 'test',
      order: 1,
      labelKey: 'menu.window.alt',
      commandId: 'window.alt',
      keybinding: 'Alt+F4',
    });
    const native = serializeMenusForNative(t);
    const save = native.find((m) => m.menu === 'file')!.items[0]!;
    const redo = native.find((m) => m.menu === 'edit')!.items[0]!;
    const altOnly = native.find((m) => m.menu === 'window')!.items[0]!;
    expect(save.label).toBe('[menu.file.save]');
    expect(save.accelerator).toBe('CmdOrCtrl+S');
    expect(redo.accelerator).toBe('CmdOrCtrl+Shift+Z');
    expect(altOnly.accelerator).toBe('Alt+F4');
  });

  test('无 keybinding 时 accelerator 字段省略', () => {
    registerMenuItem({
      id: 'help.about',
      menu: 'help',
      group: 'about',
      order: 1,
      labelKey: 'l.about',
      commandId: 'help.about',
    });
    const native = serializeMenusForNative(t);
    const about = native.find((m) => m.menu === 'help')!.items[0]!;
    expect('accelerator' in about).toBe(false);
  });

  test('输出完全 JSON 可序列化 (无函数残留,roundtrip 无损)', () => {
    registerMenuItem({
      id: 'window.toggle_chat',
      menu: 'window',
      group: 'panels',
      order: 1,
      labelKey: 'menu.window.toggle_chat',
      commandId: 'window.toggle_chat',
      keybinding: 'Ctrl+Shift+C',
      when: () => true,
      enabled: () => true,
      checked: () => true,
      danger: false,
    });
    registerMenuItem({
      id: 'file.close',
      menu: 'file',
      group: 'io',
      order: 100,
      labelKey: 'menu.file.close',
      commandId: 'file.close',
      danger: true,
    });
    const native = serializeMenusForNative(t);
    const json = JSON.stringify(native);
    const roundtrip = JSON.parse(json);
    expect(roundtrip).toEqual(native);
    // 深度扫描:确认全无 function
    const flat = JSON.stringify(native);
    expect(flat.includes('function')).toBe(false);
    expect(flat.includes('=>')).toBe(false);
  });

  test('children 子菜单也应用同一序列化规则', () => {
    registerMenuItem({
      id: 'file.recent',
      menu: 'file',
      group: 'io',
      order: 1,
      labelKey: 'menu.file.recent',
      // 父项无 commandId → 但有 children 就当作展开容器,由 enabled=false 表示不可点
      children: [
        {
          id: 'file.recent.a',
          menu: 'file',
          group: 'items',
          order: 1,
          labelKey: 'menu.file.recent.a',
          commandId: 'file.open',
          keybinding: 'Ctrl+O',
        },
        {
          id: 'file.recent.hidden',
          menu: 'file',
          group: 'items',
          order: 2,
          labelKey: 'menu.file.recent.hidden',
          commandId: 'file.open',
          when: () => false,
        },
      ],
    });
    const native = serializeMenusForNative(t);
    const recent = native.find((m) => m.menu === 'file')!.items[0]!;
    expect(recent.children).toBeDefined();
    expect(recent.children!.map((c) => c.id)).toEqual(['file.recent.a']);
    expect(recent.children![0]!.accelerator).toBe('CmdOrCtrl+O');
    expect(recent.children![0]!.label).toBe('[menu.file.recent.a]');
  });

  test('dynamicChildren 在原生序列化时求值并展开为 children', () => {
    registerMenuItem({
      id: 'file.openRecent',
      menu: 'file',
      group: 'project',
      order: 1,
      labelKey: 'menu.file.openRecent',
      // No commandId — opener with a runtime-derived submenu.
      dynamicChildren: () => [
        { id: 'file.openRecent.g1', menu: 'file', group: 'recent', order: 0,
          labelKey: 'Game One', commandId: 'game.pick', args: { slug: 'g1' } },
        { id: 'file.openRecent.g2', menu: 'file', group: 'recent', order: 0,
          labelKey: 'Game Two', commandId: 'game.pick', args: { slug: 'g2' } },
      ],
    });
    const native = serializeMenusForNative(t);
    const opener = native.find((m) => m.menu === 'file')!.items[0]!;
    // Opener has no command but children default it to enabled + a submenu.
    expect(opener.enabled).toBe(true);
    expect(opener.children).toBeDefined();
    expect(opener.children!.map((c) => c.id)).toEqual([
      'file.openRecent.g1',
      'file.openRecent.g2',
    ]);
    expect(opener.children![0]!.label).toBe('[Game One]');
  });
});
