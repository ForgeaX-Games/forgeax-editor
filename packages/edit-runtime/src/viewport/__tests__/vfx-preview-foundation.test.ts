import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../VfxPreviewViewport.tsx', import.meta.url), 'utf8');

describe('VFX asset preview foundation', () => {
  it('boots one bounded preview World through the engine host and write gate', () => {
    expect(source).toContain('createApp(');
    expect(source).toContain('createVfxRuntimeHost');
    expect(source).toContain('vfxHost.attachWorld');
    expect(source).toContain('createEngineFacade');
    expect(source).toContain("facade.allocSharedRef('ParticleEffectAsset'");
    expect(source).toContain('facade.spawn(');
    expect(source).not.toMatch(/\bapp\.world\.(spawn|set|allocSharedRef)\(/u);
  });

  it('consumes cooked runtime assets without importing the build-time compiler', () => {
    expect(source).toContain('isVfxGpuEffectAsset');
    expect(source).toContain('VFX_GPU_RUNTIME_RESOURCE_KEY');
    expect(source).not.toContain('@forgeax/engine-vfx-compiler');
  });

  it('copies renderer dependencies and exposes keyed runtime inspection', () => {
    expect(source).toContain('loadDocumentAssetPayload');
    expect(source).toContain('renderer.material');
    expect(source).toContain("renderer.kind === 'mesh'");
    expect(source).toContain('vfxHost.inspect');
    expect(source).not.toContain('gateway.doc.registry');
  });

  it('loops authored preview schedules without changing the cooked effect', () => {
    expect(source).toContain('autoReplayIntervalMs');
    expect(source).toContain('emitter.schedule.loopDuration');
    expect(source).toContain('.replay(player)');
  });
});
