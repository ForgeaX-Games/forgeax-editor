import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import type { WorkbenchManifest } from '@forgeax/types';
import { appExtensionFromManifest } from './manifest-adapter';

const base = {
  schemaVersion: 1,
  version: '1.0.0',
  kind: 'workbench',
  displayName: { zh: '样例', en: 'Sample' },
  description: { zh: 'd', en: 'd' },
  author: { name: 'forgeax', email: 'dev@forgeax.local' },
} as const;

const Comp = () => createElement('div');

describe('appExtensionFromManifest(ADR 0027 统一契约 → v9 槽)', () => {
  it('默认 surface → panels 槽,title/order/icon 来自 manifest 声明', () => {
    const m: WorkbenchManifest = {
      ...base,
      id: 'demo.dock',
      provides: { workbench: { id: 'demo', position: 7, icon: '🧪' } },
    };
    const ext = appExtensionFromManifest({ manifest: m, components: { Comp } });
    expect(ext.id).toBe('demo.dock');
    const desc = ext.contributes?.panels?.panels?.['demo'];
    expect(desc?.title).toBe('样例');
    expect(desc?.order).toBe(7);
    expect(desc?.icon).toBe('🧪');
    expect(typeof desc?.render).toBe('function');
  });

  it("surface:'detached' → detached 槽,组件按键名落位", () => {
    const m: WorkbenchManifest = {
      ...base,
      id: 'demo.detached',
      provides: { workbench: { id: 'x', surface: 'detached' } },
    };
    const ext = appExtensionFromManifest({ manifest: m, components: { AgentsBrowser: Comp } });
    expect(ext.contributes?.panels?.detached).toEqual({ AgentsBrowser: Comp });
  });

  it("surface:'overlay' → overlays 槽(settingsSection 先例路径)", () => {
    const m: WorkbenchManifest = {
      ...base,
      id: 'demo.overlay',
      provides: { workbench: { id: 'y', surface: 'overlay' } },
    };
    const ext = appExtensionFromManifest({ manifest: m, components: { Settings: Comp } });
    expect(ext.contributes?.panels?.overlays).toEqual({ Settings: Comp });
  });
});
