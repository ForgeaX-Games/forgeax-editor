import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createApplicationMenuRegistry } from '@forgeax/app-shell/application';
import { setLocale } from '@forgeax/editor-core/i18n';
import { createEditorMenuExtension } from '../editor-menu-extension';

afterEach(() => setLocale('en'));

test('Editor owns disabled selection and preview placeholders with live nested labels', () => {
  const rows = createEditorMenuExtension().contributes!.menus!;
  const placeholders = rows.filter(row => ['select.invert', 'select.byType', 'select.marquee', 'build.reload'].includes(row.id));
  expect(placeholders.map(row => row.id).sort()).toEqual(['build.reload', 'select.byType', 'select.invert', 'select.marquee']);
  const parent = placeholders.find(row => row.id === 'select.byType')!;
  expect(parent.children!.map(row => row.id)).toEqual(['select.byType.mesh', 'select.byType.light', 'select.byType.camera', 'select.byType.collider']);
  for (const row of [...placeholders, ...parent.children!]) expect(row.commandId).toBeUndefined();
  expect(parent.groupOrder).toBe(20);
  expect(parent.order).toBe(10);
  setLocale('en');
  expect(parent.children![0]!.label).toBe('Meshes');
  setLocale('zh');
  expect(parent.children![0]!.label).toBe('网格');
  expect(placeholders.find(row => row.id === 'build.reload')!.label).toBe('重新加载预览');
});

test('standalone assembles Editor menus exactly once through its public facade', () => {
  const source = readFileSync(new URL('../../../../apps/standalone/main.tsx', import.meta.url), 'utf8');
  expect(source).toContain("from '@forgeax/editor/menu-contributions'");
  expect(source.match(/createEditorMenuExtension\(\)/g)).toHaveLength(1);
});

test('Editor declares its existing commands without owning another registry', () => {
  const extension = createEditorMenuExtension();
  const items = extension.contributes?.menus ?? [];
  expect(items.filter(item => item.commandId?.startsWith('editor.')).map(item => item.commandId)).toEqual([
    'editor.save', 'editor.undo', 'editor.redo', 'editor.delete',
    'editor.play', 'editor.stop', 'editor.toggleDisplay',
    'editor.selectAll', 'editor.deselect', 'editor.frameSelected',
  ]);
  expect(items.filter(item => item.commandId === 'app.panel.toggle').map(item => item.args)).toEqual([
    { id: 'ep:hierarchy' }, { id: 'ep:inspector' }, { id: 'ep:assets' },
  ]);
});

test('Editor labels stay live across locale changes', () => {
  const save = createEditorMenuExtension().contributes!.menus!.find(item => item.id === 'file.save')!;
  setLocale('en');
  expect(save.label).toBe('Save');
  setLocale('zh');
  expect(save.label).toBe('保存');
});

test('late activation preserves section order and disposal removes only Editor rows', () => {
  const registry = createApplicationMenuRegistry();
  registry.register({ id: 'text.copy', menu: 'edit', group: 'clipboard', groupOrder: 20, order: 20, label: 'Copy' });
  const cleanups = createEditorMenuExtension().contributes!.menus!.map(item => registry.register(item));
  expect(registry.snapshot('edit').slice(0, 2).map(item => item.id)).toEqual(['edit.undo', 'edit.redo']);
  cleanups.forEach(dispose => dispose());
  expect(registry.snapshot().map(item => item.id)).toEqual(['text.copy']);
  registry.dispose();
});
