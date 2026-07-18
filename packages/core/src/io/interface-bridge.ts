// interface-bridge — project editor-core's typed PanelBridge into the host shell.
//
// Single-realm hosts (standalone + studio) inject this installer through
// PanelRenderers.editor. Interface intentionally declares only the structural
// callback shape and never imports editor-core, while editor intent stays one
// typed in-process channel — no window.postMessage compatibility mirror.
//
// These are NOT editor operations: document/session mutation has already gone
// through the EditGateway before notifications are emitted. The host currently
// reacts by inserting a chat pill.

import { panelBridge, type EditorRefPayload } from './panel-bridge';
import type { AssetChatRef } from './cross-panel-types';

export interface InterfaceBridgeHandlers {
  onEditorConsole(entry: { level: 'log' | 'warn' | 'error' | 'info' | 'debug'; text: string; ts: number }): void;
  onEditorNetwork(entry: { kind: 'fetch' | 'xhr' | 'ws'; method: string; url: string; status: number; ms: number; ok: boolean; ts: number }): void;
  onEditorRef(payload: EditorRefPayload): void;
  onAddAssetToChat(refs: AssetChatRef[]): void;
}

/** Subscribe the host shell to editor coordination notifications. The returned
 * disposer is owned by the interface App effect, so hot reload/remount cannot
 * stack duplicate chat pills or panel-focus actions. */
export function installInterfaceBridge(handlers: InterfaceBridgeHandlers): () => void {
  const offEditorConsole = panelBridge.on('editorConsole', handlers.onEditorConsole);
  const offEditorNetwork = panelBridge.on('editorNetwork', handlers.onEditorNetwork);
  const offEditorRef = panelBridge.on('editorRef', handlers.onEditorRef);
  const offAddAssetToChat = panelBridge.on('addAssetToChat', handlers.onAddAssetToChat);
  return () => {
    offEditorConsole();
    offEditorNetwork();
    offEditorRef();
    offAddAssetToChat();
  };
}
