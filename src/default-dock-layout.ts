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
          type: 'branch',
          size: 340,
          data: [
            {
              type: 'leaf',
              size: 430,
              data: { views: ['ep:hierarchy'], activeView: 'ep:hierarchy', id: 'g-hierarchy' },
            },
            {
              type: 'leaf',
              size: 382,
              data: { views: ['ep:inspector'], activeView: 'ep:inspector', id: 'g-inspector' },
            },
          ],
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
                views: ['ep:assets', 'info'],
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
    viewport: { id: 'viewport', contentComponent: 'viewport', title: 'Viewport' },
    info: { id: 'info', contentComponent: 'info', title: 'Info' },
    chat: { id: 'chat', contentComponent: 'chat', title: 'ForgeaX CLI' },
  },
  activeGroup: 'g-chat',
};
