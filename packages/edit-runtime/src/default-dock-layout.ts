// @forgeax/editor/default-dock-layout — editor chrome's default Dockview layout.
//
// This is editor-owned UI metadata, not an authored scene/scene-pack. Hosts map
// it onto the interface page-platform layout registry. Keeping the data here
// makes standalone and Studio consume the exact same editor layout instead of
// maintaining copies.
// The panel `title`s below are only SEED labels for the serialized layout —
// DockShell's `titleFor` overrides every tab title from the localized SSOT
// (interface i18n `dockShell.panelTitles.*`) right after restore AND on every
// language switch, so what the user sees is always locale-correct and live.
// Keeping plain English seeds here (instead of a second i18n lookup) avoids a
// duplicate string source. The `chat` tab keeps the "ForgeaX CLI" brand string.
import type { PanelRenderers } from '@forgeax/interface/components/DockShell/panelRenderers';

type SerializedDockview = NonNullable<PanelRenderers['builtinPageLayouts']>[string];
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
        // Center column is the viewport alone. Content Browser lives in the
        // global footer edge group (below); History / Capabilities are no longer
        // seeded here — they open on demand (Window menu / command), same as
        // ep:settings — so the viewport owns the full center height by default.
        {
          type: 'leaf',
          size: 620,
          data: { views: ['viewport'], activeView: 'viewport', id: 'g-viewport' },
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
    // Content Browser is footer chrome now (bottom edge group below) — a global
    // panel shown in the footer across every Page, not a main-grid document panel.
    'ep:assets': { id: 'ep:assets', contentComponent: 'ep:assets', title: 'Content Browser' },
    'ep:inspector': { id: 'ep:inspector', contentComponent: 'ep:inspector', title: 'Inspector' },
    viewport: { id: 'viewport', contentComponent: 'viewport', title: 'Viewport' },
    chat: { id: 'chat', contentComponent: 'chat', title: 'ForgeaX CLI' },
    // Footer chrome panels default into the merged bottom EDGE group (relocated
    // into the StatusBar footer by edgeDrawer). Content Browser (ep:assets) is
    // editor-owned but promoted to global footer chrome (interface
    // FOOTER_PANEL_ID_LIST); Info / Checkpoints / Events are interface-owned.
    // Present across every editor Page; titles localize via
    // interface i18n `dockShell.panelTitles.*`.
    info: { id: 'info', contentComponent: 'info', title: 'Info' },
    checkpoints: { id: 'checkpoints', contentComponent: 'checkpoints', title: 'Checkpoints' },
    events: { id: 'events', contentComponent: 'events', title: 'Events' },
  },
  edgeGroups: {
    bottom: {
      size: 280,
      visible: true,
      collapsed: true,
      group: {
        id: 'edge-bottom',
        views: ['ep:assets', 'info', 'checkpoints', 'events'],
        activeView: 'ep:assets',
      },
    },
  },
  activeGroup: 'g-chat',
};

/** Independent observer page layout. It has no editor panels or World host. */
export const DEFAULT_OPERATIONS_PAGE_DOCK_LAYOUT: SerializedDockview = {
  grid: {
    height: 812,
    width: 1200,
    orientation: 'HORIZONTAL' as unknown as Orientation,
    root: {
      type: 'leaf',
      size: 1200,
      data: { views: ['ep:operations-page'], activeView: 'ep:operations-page', id: 'g-operations-page' },
    },
  },
  panels: {
    'ep:operations-page': { id: 'ep:operations-page', contentComponent: 'ep:operations-page', title: 'AI Operations' },
  },
  activeGroup: 'g-operations-page',
};

/** Dedicated asset-document layout. Asset panels are intentionally absent from
 *  the Level layout above; this scope is switched by Editor Document Tabs, not
 *  by the persistent Scene/AI Page selector. */
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
          size: 1200,
          data: {
            views: ['ep:asset-properties'],
            activeView: 'ep:asset-properties',
            id: 'g-asset-properties',
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
  },
  activeGroup: 'g-asset-properties',
};

/** VFX authoring Page: system composition and details frame a large
 * isolated preview, while time and runtime truth stay adjacent below it. */
export const DEFAULT_VFX_EDITOR_DOCK_LAYOUT: SerializedDockview = {
  grid: {
    height: 812,
    width: 1200,
    orientation: 'HORIZONTAL' as unknown as Orientation,
    root: {
      type: 'branch',
      size: 812,
      data: [
        {
          type: 'leaf', size: 255,
          data: { views: ['ep:vfx-system'], activeView: 'ep:vfx-system', id: 'g-vfx-system' },
        },
        {
          type: 'branch', size: 650,
          data: [
            {
              type: 'leaf', size: 555,
              data: { views: ['ep:vfx-preview'], activeView: 'ep:vfx-preview', id: 'g-vfx-preview' },
            },
            {
              type: 'leaf', size: 257,
              data: {
                views: ['ep:vfx-timeline', 'ep:vfx-diagnostics'],
                activeView: 'ep:vfx-timeline',
                id: 'g-vfx-bottom',
              },
            },
          ],
        },
        {
          type: 'leaf', size: 295,
          data: {
            views: ['ep:vfx-details'],
            activeView: 'ep:vfx-details',
            id: 'g-vfx-details',
          },
        },
      ],
    },
  },
  panels: {
    'ep:vfx-system': { id: 'ep:vfx-system', contentComponent: 'ep:vfx-system', title: 'System Outline' },
    'ep:vfx-preview': { id: 'ep:vfx-preview', contentComponent: 'ep:vfx-preview', title: 'Preview' },
    'ep:vfx-timeline': { id: 'ep:vfx-timeline', contentComponent: 'ep:vfx-timeline', title: 'Timeline' },
    'ep:vfx-details': { id: 'ep:vfx-details', contentComponent: 'ep:vfx-details', title: 'Details' },
    'ep:vfx-diagnostics': { id: 'ep:vfx-diagnostics', contentComponent: 'ep:vfx-diagnostics', title: 'Diagnostics' },
  },
  activeGroup: 'g-vfx-preview',
};

/** Mesh document family: independent 3D preview on the left, read-only
 * properties/overview/material slots stacked on the right. */
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
          size: 680,
          data: {
            views: ['ep:mesh-preview'],
            activeView: 'ep:mesh-preview',
            id: 'g-mesh-preview',
          },
        },
        {
          type: 'branch',
          size: 520,
          data: [
            {
              type: 'leaf',
              size: 380,
              data: {
                views: ['ep:asset-properties'],
                activeView: 'ep:asset-properties',
                id: 'g-mesh-properties',
              },
            },
            {
              type: 'leaf',
              size: 212,
              data: {
                views: ['ep:mesh-slots'],
                activeView: 'ep:mesh-slots',
                id: 'g-mesh-slots',
              },
            },
            {
              type: 'leaf',
              size: 260,
              data: {
                views: ['ep:uv-editor'],
                activeView: 'ep:uv-editor',
                id: 'g-uv-editor',
              },
            },
          ],
        },
      ],
    },
  },
  panels: {
    'ep:mesh-preview': {
      id: 'ep:mesh-preview',
      contentComponent: 'ep:mesh-preview',
      title: 'Preview',
    },
    'ep:asset-properties': {
      id: 'ep:asset-properties',
      contentComponent: 'ep:asset-properties',
      title: 'Mesh Properties',
    },
    'ep:mesh-slots': {
      id: 'ep:mesh-slots',
      contentComponent: 'ep:mesh-slots',
      title: 'Material Slots',
    },
    'ep:uv-editor': {
      id: 'ep:uv-editor',
      contentComponent: 'ep:uv-editor',
      title: 'UV Editor',
    },
  },
  activeGroup: 'g-mesh-properties',
};

/** Material document family: UE-style material editor — 3D preview viewport on
 *  the left, schema-driven parameter panel + asset overview stacked right. */
export const DEFAULT_MATERIAL_EDITOR_DOCK_LAYOUT: SerializedDockview = {
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
          size: 680,
          data: {
            views: ['ep:mat-preview'],
            activeView: 'ep:mat-preview',
            id: 'g-mat-preview',
          },
        },
        {
          type: 'leaf',
          size: 520,
          data: {
            views: ['ep:asset-properties'],
            activeView: 'ep:asset-properties',
            id: 'g-mat-properties',
          },
        },
      ],
    },
  },
  panels: {
    'ep:mat-preview': {
      id: 'ep:mat-preview',
      contentComponent: 'ep:mat-preview',
      title: 'Preview',
    },
    'ep:asset-properties': {
      id: 'ep:asset-properties',
      contentComponent: 'ep:asset-properties',
      title: 'Material Parameters',
    },
  },
  activeGroup: 'g-mat-properties',
};

/** Texture document family: UE-style texture editor — GPU preview viewport on
 *  the left, texture import facts + metadata stacked right. */
export const DEFAULT_TEXTURE_EDITOR_DOCK_LAYOUT: SerializedDockview = {
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
          size: 680,
          data: {
            views: ['ep:texture-preview'],
            activeView: 'ep:texture-preview',
            id: 'g-texture-preview',
          },
        },
        {
          type: 'leaf',
          size: 520,
          data: {
            views: ['ep:asset-properties'],
            activeView: 'ep:asset-properties',
            id: 'g-texture-properties',
          },
        },
      ],
    },
  },
  panels: {
    'ep:texture-preview': {
      id: 'ep:texture-preview',
      contentComponent: 'ep:texture-preview',
      title: 'Preview',
    },
    'ep:asset-properties': {
      id: 'ep:asset-properties',
      contentComponent: 'ep:asset-properties',
      title: 'Texture Properties',
    },
  },
  activeGroup: 'g-texture-properties',
};

/** Material Instance editor: left preview viewport + right properties panel.
 *  Independent of Mesh/Asset layouts (PRD FR-1.4). */
export const DEFAULT_MI_EDITOR_DOCK_LAYOUT: SerializedDockview = {
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
          size: 780,
          data: {
            views: ['ep:mi-preview'],
            activeView: 'ep:mi-preview',
            id: 'g-mi-preview',
          },
        },
        {
          type: 'leaf',
          size: 420,
          data: {
            views: ['ep:mi-properties'],
            activeView: 'ep:mi-properties',
            id: 'g-mi-properties',
          },
        },
      ],
    },
  },
  panels: {
    'ep:mi-preview': {
      id: 'ep:mi-preview',
      contentComponent: 'ep:mi-preview',
      title: 'Preview',
    },
    'ep:mi-properties': {
      id: 'ep:mi-properties',
      contentComponent: 'ep:mi-properties',
      title: 'Properties',
    },
  },
  activeGroup: 'g-mi-properties',
};

/** Input Map editor: properties-only (no 3D preview in P0). */
export const DEFAULT_INPUT_MAP_EDITOR_DOCK_LAYOUT: SerializedDockview = {
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
          size: 1200,
          data: {
            views: ['ep:input-map-properties'],
            activeView: 'ep:input-map-properties',
            id: 'g-input-map-properties',
          },
        },
      ],
    },
  },
  panels: {
    'ep:input-map-properties': {
      id: 'ep:input-map-properties',
      contentComponent: 'ep:input-map-properties',
      title: 'Input Map',
    },
  },
  activeGroup: 'g-input-map-properties',
};
