// Editor owns menu intent, ordering and localized labels; the host owns registration.
// Command execution remains in the existing Editor command/Gateway owners.
import type { AppExtension, ApplicationMenuItem } from '@forgeax/app-shell/application';
import { isDockPanelVisible } from '@forgeax/app-shell/dock';
import { t } from '@forgeax/editor-core/i18n';

export function createEditorMenuExtension(): AppExtension {
  const menus: ApplicationMenuItem[] = [
    { id: 'file.save', menu: 'file', group: 'file', groupOrder: 20, order: 10,
        get label() { return t('editorMenu.file.save'); }, icon: 'save',
        commandId: 'editor.save', keybinding: 'Ctrl+S' },
    { id: 'edit.undo', menu: 'edit', group: 'history', groupOrder: 10, order: 10,
        get label() { return t('editorMenu.edit.undo'); }, icon: 'undo-2',
        commandId: 'editor.undo', keybinding: 'Ctrl+Z' },
    { id: 'edit.redo', menu: 'edit', group: 'history', groupOrder: 10, order: 20,
        get label() { return t('editorMenu.edit.redo'); }, icon: 'redo-2',
        commandId: 'editor.redo', keybinding: 'Ctrl+Shift+Z' },
    { id: 'edit.delete', menu: 'edit', group: 'clipboard', groupOrder: 20, order: 40,
        get label() { return t('editorMenu.edit.delete'); }, icon: 'trash-2', danger: true,
        commandId: 'editor.delete' },
    { id: 'window.outline', menu: 'window', group: 'panels', groupOrder: 10, order: 10,
        get label() { return t('editorMenu.window.outline'); },
        commandId: 'app.panel.toggle', args: { id: 'ep:hierarchy' }, checked: () => isDockPanelVisible('ep:hierarchy') },
    { id: 'window.inspector', menu: 'window', group: 'panels', groupOrder: 10, order: 20,
        get label() { return t('editorMenu.window.inspector'); },
        commandId: 'app.panel.toggle', args: { id: 'ep:inspector' }, checked: () => isDockPanelVisible('ep:inspector') },
    { id: 'window.files', menu: 'window', group: 'panels', groupOrder: 10, order: 30,
        get label() { return t('editorMenu.window.files'); },
        commandId: 'app.panel.toggle', args: { id: 'ep:assets' }, checked: () => isDockPanelVisible('ep:assets') },
    { id: 'build.play', menu: 'build', group: 'run', groupOrder: 10, order: 10,
        get label() { return t('editorMenu.build.play'); }, icon: 'play',
        commandId: 'editor.play' },
    { id: 'build.stop', menu: 'build', group: 'run', groupOrder: 10, order: 20,
        get label() { return t('editorMenu.build.stop'); }, icon: 'square',
        commandId: 'editor.stop' },
    { id: 'build.editScene', menu: 'build', group: 'run', groupOrder: 10, order: 30,
        get label() { return t('editorMenu.build.editScene'); }, icon: 'pencil',
        commandId: 'editor.toggleDisplay' },
    // Preserve unwired preview intent as a disabled row, not a no-op command.
    { id: 'build.reload', menu: 'build', group: 'run', groupOrder: 10, order: 40,
        get label() { return t('editorMenu.build.reload'); }, icon: 'refresh-cw' },
    { id: 'select.all', menu: 'select', group: 'basic', groupOrder: 10, order: 10,
        get label() { return t('editorMenu.select.all'); }, icon: 'box-select',
        commandId: 'editor.selectAll', keybinding: 'Ctrl+A' },
    { id: 'select.none', menu: 'select', group: 'basic', groupOrder: 10, order: 20,
        get label() { return t('editorMenu.select.none'); }, icon: 'square-dashed',
        commandId: 'editor.deselect' },
    { id: 'select.invert', menu: 'select', group: 'basic', groupOrder: 10, order: 30,
        get label() { return t('editorMenu.select.invert'); }, icon: 'flip-horizontal-2' },
    { id: 'select.byType', menu: 'select', group: 'byCond', groupOrder: 20, order: 10,
        get label() { return t('editorMenu.select.byType'); }, icon: 'shapes',
        children: [
          { id: 'select.byType.mesh', menu: 'select', group: 'byCond', groupOrder: 20, order: 10,
              get label() { return t('editorMenu.select.byType.mesh'); } },
          { id: 'select.byType.light', menu: 'select', group: 'byCond', groupOrder: 20, order: 20,
              get label() { return t('editorMenu.select.byType.light'); } },
          { id: 'select.byType.camera', menu: 'select', group: 'byCond', groupOrder: 20, order: 30,
              get label() { return t('editorMenu.select.byType.camera'); } },
          { id: 'select.byType.collider', menu: 'select', group: 'byCond', groupOrder: 20, order: 40,
              get label() { return t('editorMenu.select.byType.collider'); } },
        ] },
    { id: 'select.marquee', menu: 'select', group: 'byCond', groupOrder: 20, order: 20,
        get label() { return t('editorMenu.select.marquee'); }, icon: 'scan' },
    { id: 'select.frame', menu: 'select', group: 'view', groupOrder: 30, order: 10,
        get label() { return t('editorMenu.select.frame'); }, icon: 'focus',
        commandId: 'editor.frameSelected' },
  ];
  return { id: 'editor-menus', version: '1.0.0', contributes: { menus } };
}
