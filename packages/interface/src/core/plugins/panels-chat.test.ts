// packages/interface/src/core/plugins/panels-chat.test.ts
import { describe, expect, it } from 'bun:test';
import { createAppHost } from '../app-shell/host';
import { panelsChatPlugin } from './panels-chat';

describe('panels-chat', () => {
  it('registers app.chat.insertPill command', () => {
    const { host, control } = createAppHost();
    control.beginSetup(panelsChatPlugin as any);
    const ctx: any = {
      host,
      bus: host.bus,
      storage: host.storage,
      log: console,
      registerCommand: (c: any) => host.commands.register(c),
    };
    void panelsChatPlugin.setup!(ctx);
    control.endSetup();
    expect(host.commands.get('app.chat.insertPill')).toBeDefined();
  });
});
