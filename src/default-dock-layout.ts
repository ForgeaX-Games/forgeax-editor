// @forgeax/editor/default-dock-layout — editor chrome's default Dockview layout.
//
// This is editor-owned UI metadata, not an authored scene/scene-pack. Hosts map
// it onto their interface-owned built-in workspace key (`scene`) through
// PanelRenderers.builtinWorkbenchLayouts. Keeping the data here makes standalone
// and Studio consume the exact same editor layout instead of maintaining copies.
import type { PanelRenderers } from '@forgeax/interface/components/DockShell/panelRenderers';
// The panel `title`s below are only SEED labels for the serialized layout —
// DockShell's `titleFor` overrides every tab title from the localized SSOT
// (interface i18n `dockShell.panelTitles.*`) right after restore AND on every
// language switch, so what the user sees is always locale-correct and live.
// Keeping plain English seeds here (instead of a second i18n lookup) avoids a
// duplicate string source. The `chat` tab keeps the "ForgeaX CLI" brand string.

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
          size: 250,
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
            { type: 'leaf', size: 500, data: { views: ['viewport'], activeView: 'viewport', id: 'g-viewport' } },
            {
              type: 'leaf',
              // Keep enough default height for the Content Browser grid.
              // History is a peer tab here rather than a dedicated strip.
              size: 312,
              data: {
                views: ['ep:assets', 'ep:history', 'ep:capabilities'],
                activeView: 'ep:assets',
                id: 'g-content-browser',
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
    'ep:history': { id: 'ep:history', contentComponent: 'ep:history', title: 'History' },
    'ep:capabilities': { id: 'ep:capabilities', contentComponent: 'ep:capabilities', title: 'Capabilities' },
    viewport: { id: 'viewport', contentComponent: 'viewport', title: 'Viewport' },
    chat: { id: 'chat', contentComponent: 'chat', title: 'ForgeaX CLI' },
  },
  activeGroup: 'g-chat',
};

/** Dedicated asset-document layout. Asset panels are intentionally absent from
 *  the Level layout above; this scope is switched by Editor Document Tabs, not
 *  by the persistent Scene/AI workbench selector. */
export const DEFAULT_ASSET_EDITOR_DOCK_LAYOUT: SerializedDockview = {
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
          size: 880,
          data: {
            views: ['ep:asset-properties'],
            activeView: 'ep:asset-properties',
            id: 'g-asset-properties',
          },
        },
        {
          type: 'leaf',
          size: 320,
          data: {
            views: ['ep:asset-overview'],
            activeView: 'ep:asset-overview',
            id: 'g-asset-overview',
          },
        },
      ],
    },
  },
  panels: {
    'ep:asset-properties': {
      id: 'ep:asset-properties',
      contentComponent: 'ep:asset-properties',
      title: 'Properties',
    },
    'ep:asset-overview': {
      id: 'ep:asset-overview',
      contentComponent: 'ep:asset-overview',
      title: 'Asset Overview',
    },
  },
  activeGroup: 'g-asset-properties',
};

/** Mesh document family. It shares the asset overview/property vocabulary but
 * owns an additional material-slot panel that no other page can restore. */
export const DEFAULT_MESH_EDITOR_DOCK_LAYOUT: SerializedDockview = {
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
          size: 820,
          data: {
            views: ['ep:asset-properties'],
            activeView: 'ep:asset-properties',
            id: 'g-mesh-properties',
          },
        },
        {
          type: 'branch',
          size: 380,
          data: [
            {
              type: 'leaf',
              size: 300,
              data: {
                views: ['ep:asset-overview'],
                activeView: 'ep:asset-overview',
                id: 'g-mesh-overview',
              },
            },
            {
              type: 'leaf',
              size: 512,
              data: {
                views: ['ep:mesh-slots'],
                activeView: 'ep:mesh-slots',
                id: 'g-mesh-slots',
              },
            },
          ],
        },
      ],
    },
  },
  panels: {
    'ep:asset-properties': {
      id: 'ep:asset-properties',
      contentComponent: 'ep:asset-properties',
      title: 'Mesh Properties',
    },
    'ep:asset-overview': {
      id: 'ep:asset-overview',
      contentComponent: 'ep:asset-overview',
      title: 'Asset Overview',
    },
    'ep:mesh-slots': {
      id: 'ep:mesh-slots',
      contentComponent: 'ep:mesh-slots',
      title: 'Material Slots',
    },
  },
  activeGroup: 'g-mesh-properties',
};
