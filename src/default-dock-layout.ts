// @forgeax/editor/default-dock-layout — editor chrome's default Dockview layout.
//
// This is editor-owned UI metadata, not an authored scene/scene-pack. Hosts map
// it onto their interface-owned built-in workspace key (`scene`) through
// PanelRenderers.builtinWorkbenchLayouts. Keeping the data here makes standalone
// and Studio consume the exact same editor layout instead of maintaining copies.
import type { PanelRenderers } from '@forgeax/interface/components/DockShell/panelRenderers';

type SerializedDockview = NonNullable<PanelRenderers['builtinWorkbenchLayouts']>[string];
type Orientation = SerializedDockview['grid']['orientation'];

/** The default dock arrangement for the editor's live panel manifest. */
export const DEFAULT_EDITOR_DOCK_LAYOUT: SerializedDockview = {
  grid: {
    height: 812,
    width: 1200,
    orientation: 'HORIZONTAL' as unknown as Orientation,
    root: {
      type: 'branch',
      size: 812,
      data: [
        {
          type: 'leaf',
          size: 340,
          data: {
            views: [
              'ep:hierarchy', 'ep:inspector', 'ep:launcher',
              'ep:asset-inspector',
            ],
            activeView: 'ep:hierarchy',
            id: 'g-left-tabs',
          },
        },
        {
          type: 'branch',
          size: 620,
          data: [
            { type: 'leaf', size: 612, data: { views: ['viewport'], activeView: 'viewport', id: 'g-viewport' } },
            {
              type: 'leaf',
              size: 200,
              data: {
                views: ['ep:assets', 'ep:history', 'ep:capabilities', 'info'],
                activeView: 'ep:assets',
                id: 'g-history',
              },
            },
          ],
        },
        {
          type: 'leaf',
          size: 240,
          data: { views: ['chat'], activeView: 'chat', id: 'g-chat' },
        },
      ],
    },
  },
  panels: {
    'ep:hierarchy': { id: 'ep:hierarchy', contentComponent: 'ep:hierarchy', title: 'Hierarchy' },
    'ep:assets': { id: 'ep:assets', contentComponent: 'ep:assets', title: 'Assets' },
    'ep:inspector': { id: 'ep:inspector', contentComponent: 'ep:inspector', title: 'Inspector' },
    'ep:launcher': { id: 'ep:launcher', contentComponent: 'ep:launcher', title: 'Launcher' },
    'ep:asset-inspector': { id: 'ep:asset-inspector', contentComponent: 'ep:asset-inspector', title: 'Asset Inspector' },
    viewport: { id: 'viewport', contentComponent: 'viewport', title: 'Viewport' },
    'ep:history': { id: 'ep:history', contentComponent: 'ep:history', title: 'History' },
    'ep:capabilities': { id: 'ep:capabilities', contentComponent: 'ep:capabilities', title: 'Capabilities' },
    info: { id: 'info', contentComponent: 'info', title: 'Info' },
    chat: { id: 'chat', contentComponent: 'chat', title: 'ForgeaX CLI' },
  },
  activeGroup: 'g-chat',
};
