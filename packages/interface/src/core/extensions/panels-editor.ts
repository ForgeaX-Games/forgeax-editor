// packages/interface/src/core/extensions/panels-editor.ts
//
// Contributes ep:* editor panel ids to host.panels.editorPanelIds + registers
// the app.editor.focus command. Studio's editor injection module replaces the
// default ids list by installing this extension with overrides — see studio's
// studioExtensions assembly.
//
// Mixed-form sample (ADR 0025 M2): panel data is DECLARATIVE (`contributes`),
// the command registration stays imperative (`setup`).
import type { AppExtension } from '../app-shell/types';
import type { PanelRenderers } from '../../components/DockShell/panelRenderers';
import { DEFAULT_EDITOR_PANEL_IDS } from '../../components/DockShell/panelRenderers';

export interface PanelsEditorOptions {
  readonly editorPanelIds?: readonly string[];
  readonly panels?: PanelRenderers['panels'];
  readonly surfaces?: PanelRenderers['surfaces'];
}

export function createPanelsEditorExtension(opts: PanelsEditorOptions = {}): AppExtension {
  return {
    id: 'panels.editor', version: '1.0.0',
    requires: ['commands'],
    contributes: {
      panels: {
        editorPanelIds: opts.editorPanelIds ?? DEFAULT_EDITOR_PANEL_IDS,
        panels: opts.panels,
        surfaces: opts.surfaces,
      },
    },
    setup(ctx) {
      return ctx.registerCommand({
        id: 'app.editor.focus',
        title: 'Focus an editor panel by short id (hierarchy / assets / mesh / ...)',
        execute: (args) => {
          const p = args as { panel?: string } | undefined;
          if (!p?.panel) throw new Error('app.editor.focus: missing { panel }');
          return ctx.host.commands.execute('app.panel.focus', { id: `ep:${p.panel}` });
        },
      });
    },
  };
}
