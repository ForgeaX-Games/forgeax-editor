// panel-bridge.test.ts — single-realm editor coordination notifications.
//
// This is deliberately NOT an operation test: all document/session mutation
// reaches the EditGateway before a bridge notification occurs. It proves the
// typed transport used by Content Browser, viewport diagnostics, and injected
// shell callbacks delivers data synchronously and disposers prevent duplicate
// host reactions after a remount.

import { describe, expect, it } from 'bun:test';
import { panelBridge } from '../io/panel-bridge';

describe('panelBridge', () => {
  it('delivers an assetsChanged hint and stops after dispose', () => {
    const hints: Array<string | undefined> = [];
    const off = panelBridge.on('assetsChanged', ({ hint }) => hints.push(hint));
    panelBridge.emit('assetsChanged', { hint: 'directory-only' });
    off();
    panelBridge.emit('assetsChanged', { hint: 'pack-changed' });
    expect(hints).toEqual(['directory-only']);
  });

  it('delivers in-process editor diagnostics without postMessage', () => {
    const consoleEntries: string[] = [];
    const networks: string[] = [];
    const offConsole = panelBridge.on('editorConsole', (entry) => consoleEntries.push(`${entry.level}:${entry.text}`));
    const offNetwork = panelBridge.on('editorNetwork', (entry) => networks.push(`${entry.kind}:${entry.url}`));
    panelBridge.emit('editorConsole', { level: 'warn', text: 'asset miss', ts: 1 });
    panelBridge.emit('editorNetwork', { kind: 'fetch', method: 'GET', url: '/api/files', status: 404, ms: 2, ok: false, ts: 3 });
    offConsole();
    offNetwork();
    expect(consoleEntries).toEqual(['warn:asset miss']);
    expect(networks).toEqual(['fetch:/api/files']);
  });

  it('keeps drag coordination separate from the gateway spawn op', () => {
    const refs: string[] = [];
    const off = panelBridge.on('dragAssetStart', (ref) => refs.push(ref.guid ?? 'none'));
    panelBridge.emit('dragAssetStart', { type: 'asset', guid: 'mesh-1', kind: 'mesh', name: 'Cube' });
    off();
    expect(refs).toEqual(['mesh-1']);
  });
});
