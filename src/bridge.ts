// @forgeax/editor/bridge — pass-through to editor-core's host-bridge surface.
//
// Host-facing editor bridge surface. Re-exported here so hosts consume the
// facade (`@forgeax/editor/*`) instead of reaching into editor-core.
export {
  gateway,
  installInterfaceBridge,
  setContextMenuRenderer,
  panelBridge,
} from '@forgeax/editor-core';
