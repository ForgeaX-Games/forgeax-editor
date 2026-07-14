// @forgeax/editor/bridge — pass-through to editor-core's host-bridge surface.
//
// The three symbols a host needs to wire the editor into its shell:
// installInterfaceBridge (connects editor-core to the interface store),
// setContextMenuRenderer (host-provided context-menu impl), and panelBridge
// (the editor↔host panel event channel). Re-exported here so hosts consume
// the facade (`@forgeax/editor/*`) instead of reaching into editor-core.
export {
  installInterfaceBridge,
  setContextMenuRenderer,
  panelBridge,
} from '@forgeax/editor-core';
