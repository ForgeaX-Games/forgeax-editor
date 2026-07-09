// packages/interface/src/core/plugins/panels-editor.ts
//
// Contributes ep:* editor panel ids to host.panels.editorPanelIds + registers
// app.editor.focus command. Studio's editor injection module replaces the
// default ids list by re-installing this plugin with a `editorPanelIds`
// override — see studio's plugin bootstrap in the final pin bump PR.
import type { AppPlugin } from '../app-shell/types';
import type { PanelRenderers } from '../../components/DockShell/panelRenderers';
import { DEFAULT_EDITOR_PANEL_IDS } from '../../components/DockShell/panelRenderers';

export interface PanelsEditorOptions {
  readonly editorPanelIds?: readonly string[];
  readonly panels?: PanelRenderers['panels'];
  readonly surfaces?: PanelRenderers['surfaces'];
}

export function createPanelsEditorPlugin(opts: PanelsEditorOptions = {}): AppPlugin {
  return {
    id: 'panels.editor', version: '1.0.0',
    requires: ['panels', 'commands'],
    setup(ctx) {
      const cleanups: Array<() => void> = [];
      cleanups.push(ctx.contributePanels({
        editorPanelIds: opts.editorPanelIds ?? DEFAULT_EDITOR_PANEL_IDS,
        panels: opts.panels,
        surfaces: opts.surfaces,
      }));
      cleanups.push(ctx.registerCommand({
        id: 'app.editor.focus',
        title: 'Focus an editor panel by short id (hierarchy / assets / mesh / ...)',
        execute: (args) => {
          const p = args as { panel?: string } | undefined;
          if (!p?.panel) throw new Error('app.editor.focus: missing { panel }');
          return ctx.host.commands.execute('app.panel.focus', { id: `ep:${p.panel}` });
        },
      }));
      // slice() to avoid mutating the array we're iterating in reverse.
      return () => { for (const c of cleanups.slice().reverse()) c(); };
    },
  };
}
