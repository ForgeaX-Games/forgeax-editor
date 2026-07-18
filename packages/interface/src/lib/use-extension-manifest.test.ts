// manifestMatchesId — the single manifest-resolution match point. Three
// accepted id forms (see the function's doc comment): canonical manifest id,
// workbench short alias, and the pre-rename `@forgeax-plugin/*` namespace
// still living in old persisted dock layouts (localStorage).
import { describe, expect, it } from 'bun:test';
import { manifestMatchesId } from './use-extension-manifest';
import type { ExtensionInfo } from './extension-api';

const m = {
  id: '@forgeax-extension/wb-observatory',
  workbench: { id: 'wb-observatory' },
} as unknown as ExtensionInfo;

describe('manifestMatchesId', () => {
  it('matches the canonical manifest id', () => {
    expect(manifestMatchesId(m, '@forgeax-extension/wb-observatory')).toBe(true);
  });

  it('matches the workbench short alias', () => {
    expect(manifestMatchesId(m, 'wb-observatory')).toBe(true);
  });

  it('normalizes the legacy @forgeax-plugin/* namespace (persisted layouts)', () => {
    expect(manifestMatchesId(m, '@forgeax-plugin/wb-observatory')).toBe(true);
  });

  it('rejects a different extension', () => {
    expect(manifestMatchesId(m, '@forgeax-extension/wb-reel')).toBe(false);
    expect(manifestMatchesId(m, '@forgeax-plugin/wb-reel')).toBe(false);
  });
});
