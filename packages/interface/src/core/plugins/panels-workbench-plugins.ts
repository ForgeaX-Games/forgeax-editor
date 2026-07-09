// packages/interface/src/core/plugins/panels-workbench-plugins.ts
import type { AppPlugin } from '../app-shell/types';
import type { PanelRenderers } from '../../components/DockShell/panelRenderers';

/** Studio owns the concrete workbenchPanels record (wb:* iframe descriptors);
 *  this plugin lifts it into host.panels.workbenchPanels so DockShell reads
 *  a single source. */
export function createPanelsWorkbenchPluginsPlugin(
  workbenchPanels: PanelRenderers['workbenchPanels'],
): AppPlugin {
  return {
    id: 'panels.workbench-plugins', version: '1.0.0',
    requires: ['panels'],
    setup(ctx) { return ctx.contributePanels({ workbenchPanels }); },
  };
}
