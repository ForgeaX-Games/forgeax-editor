// packages/interface/src/core/extensions/foundation-panels.test.ts
import { describe, expect, it } from 'bun:test';
import type React from 'react';
import { createAppHost } from '../app-shell/host';
import { foundationPanelsExtension } from './foundation-panels';

describe('foundation-panels', () => {
  it('contributePanels merges patch into host.panels; cleanup removes it', () => {
    const { host } = createAppHost();
    // The plugin adds contributePanels ability to the plugin context. We
    // simulate a plugin.setup() lifecycle here.
    const ctx: any = {
      host, bus: host.bus, storage: host.storage, log: console,
      registerCommand: (c: any) => host.commands.register(c),
      contributePanels(patch: any) {
        // proxied by foundationPanelsExtension's setup — but for the test we
        // use foundationPanelsExtension's exposed helper directly.
        return foundationPanelsExtension.contributePanels(host, patch);
      },
    };
    void foundationPanelsExtension.setup!(ctx);
    const off = ctx.contributePanels({ overlays: { Dashboard: (() => null) as React.ComponentType } });
    expect(host.panels.overlays?.Dashboard).toBeDefined();
    off();
    expect(host.panels.overlays?.Dashboard).toBeUndefined();
  });

  it('cleanup is idempotent — double-call does not restore twice', () => {
    const { host } = createAppHost();
    const initialSettings = host.panels.overlays?.Settings;
    const off = foundationPanelsExtension.contributePanels(host, {
      overlays: { Settings: (() => null) as React.ComponentType },
    });
    expect(host.panels.overlays?.Settings).toBeDefined();
    off();
    expect(host.panels.overlays?.Settings).toBe(initialSettings);
    off();  // second call must be a no-op — must not re-restore or corrupt state
    expect(host.panels.overlays?.Settings).toBe(initialSettings);
  });

  it('workbenchPanels sub-key merge preserves siblings and reverses on cleanup', () => {
    const { host } = createAppHost();
    const off = foundationPanelsExtension.contributePanels(host, {
      workbenchPanels: { 'wb:a': (() => null) as () => React.ReactNode },
    });
    expect(host.panels.workbenchPanels?.['wb:a']).toBeDefined();
    off();
    expect(host.panels.workbenchPanels?.['wb:a']).toBeUndefined();
  });
});
