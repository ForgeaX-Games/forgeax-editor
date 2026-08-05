import { describe, expect, it } from 'bun:test';
import { standaloneRhiDebugPlugins } from '../../rhi-debug-config';

describe('standalone RHI debug Vite gate', () => {
  it('stays absent by default', () => {
    expect(standaloneRhiDebugPlugins({})).toEqual([]);
  });

  it('registers the capture plugin for the product start flag', () => {
    expect(standaloneRhiDebugPlugins({ FORGEAX_ENGINE_RHI_DEBUG: '1' }))
      .toMatchObject([{ name: 'forgeax:rhi-debug' }]);
  });

  it('does not treat other values as enabled', () => {
    expect(standaloneRhiDebugPlugins({ FORGEAX_ENGINE_RHI_DEBUG: '0' })).toEqual([]);
    expect(standaloneRhiDebugPlugins({ FORGEAX_ENGINE_RHI_DEBUG: 'true' })).toEqual([]);
  });
});
