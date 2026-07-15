// packages/interface/src/core/extensions/panels-workbench-plugins.ts
import type { AppExtension } from '../app-shell/types';
import type { PanelRenderers } from '../../components/DockShell/panelRenderers';

/** Studio owns the concrete workbenchPanels record (wb:* iframe descriptors);
 *  this plugin lifts it into host.panels.workbenchPanels so DockShell reads
 *  a single source. */
export function createPanelsWorkbenchInlineExtension(
  workbenchPanels: PanelRenderers['workbenchPanels'],
): AppExtension {
  return {
    id: 'panels.workbench-plugins', version: '1.0.0',
    contributes: { panels: { workbenchPanels } },
  };
}
