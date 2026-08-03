import { describe, expect, it } from 'bun:test';
import { metaPathForSource, registryEntryToCBAsset, fileFamilyOf, fileFamilyOfWithAssets } from './content-browser-format';
import { getImportFormat, isImportable } from './import-registry';

describe('UI asset Content Browser support', () => {
  it('recognizes the compound UI source extension without treating the CSS companion as an asset', () => {
    expect(getImportFormat('hud.ui.html')?.importer).toBe('ui');
    expect(isImportable('hud.ui.html')).toBe(true);
    expect(isImportable('hud.ui.css')).toBe(false);
  });

  it('keeps the engine UI sidecar convention and source location distinct', () => {
    expect(metaPathForSource('assets/ui/hud.ui.html')).toBe('assets/ui/hud.meta.json');
    const asset = registryEntryToCBAsset({
      guid: 'ui-guid',
      kind: 'ui',
      name: 'HUD',
      packageUrl: '/__forgeax-ddc/ui-guid.pack.json',
      sourcePath: 'assets/ui/hud.ui.html',
    }, 0);
    expect(asset.sourcePath).toBe('assets/ui/hud.ui.html');
    expect(asset.packPath).toBe('assets/ui/hud.meta.json');
  });

  it('keeps authored packs writable when dev projects them through a DDC URL', () => {
    const asset = registryEntryToCBAsset({
      guid: 'material-guid',
      kind: 'material',
      name: 'Metal',
      packageUrl: '/__forgeax-ddc/material-guid.pack.json',
      sourcePath: 'sample/assets/Materials.pack.json',
    }, 0);
    expect(asset.packPath).toBe('sample/assets/Materials.pack.json');
  });

  it('projects producer authoring facts onto the browser asset without a kind switch', () => {
    const authoring = {
      placement: { operation: 'spawnEntity' as const },
      binding: { operation: 'unavailable' as const, reason: { code: 'missing-producer-capability' as const, hint: 'provider-owned' } },
    };
    expect(registryEntryToCBAsset({
      guid: 'custom-guid', kind: 'host/new-kind', packageUrl: '/custom.pack.json', authoring,
    }, 0).authoring).toEqual(authoring);
  });

  it('keeps authoring sources and sidecars separate from UI asset cards', () => {
    expect(fileFamilyOf('hud.ui.html')).toBe('code');
    expect(fileFamilyOf('hud.ui.css')).toBe('code');
    expect(fileFamilyOfWithAssets('hud.meta.json', [{ kind: 'ui' }])).toBe('meta');
  });
});
