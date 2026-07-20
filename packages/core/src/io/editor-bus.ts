/**
 * @deprecated Renamed to panel-bridge.ts. This file re-exports for backward
 * compatibility — new code should import from './panel-bridge' or the barrel.
 */
export { panelBridge as editorBus, panelBridge } from './panel-bridge';
export type { PanelBridgeEvents as EditorBusEvents, EditorRefPayload, PanelBridgeEvents } from './panel-bridge';
