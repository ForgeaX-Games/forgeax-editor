import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../VfxPreviewViewport.tsx', import.meta.url), 'utf8');
const sessionAppliers = readFileSync(new URL('../viewport-session-appliers.ts', import.meta.url), 'utf8');

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
    expect(source).toContain('vfxHost.acquireControl(app.world)');
    expect(source).toContain('previewErrorHint(error)');
    expect(source).not.toContain('VFX_GPU_RUNTIME_RESOURCE_KEY');
    expect(source).not.toContain('VfxGpuRuntime');
    expect(source).not.toContain('@forgeax/engine-vfx-compiler');
    expect(sessionAppliers).toContain('deps.replayParticleEffect(entity)');
    expect(sessionAppliers).not.toContain('VFX_GPU_RUNTIME_RESOURCE_KEY');
    expect(sessionAppliers).not.toContain('VfxGpuRuntime');
  });

  it('uses the active scoped runtime producer for authored shader packages', () => {
    expect(source).toContain('createPreviewBundlerOptions()');
    expect(readFileSync(new URL('../preview-bundler-options.ts', import.meta.url), 'utf8'))
      .toContain('createDevImportTransport(binding)');
  });

  it('copies renderer dependencies and exposes keyed runtime inspection', () => {
    expect(source).toContain('loadDocumentAssetPayload');
    expect(source).toContain('renderer.material');
    expect(source).toContain("renderer.kind === 'mesh'");
    expect(source).toContain('vfxHost.inspect');
    expect(source).not.toContain('gateway.doc.registry');
  });

  it('keeps bounded preview chrome behind the mini-world write gate and shared App frame authority', () => {
    expect(source).toContain('setPlaying(next: boolean)');
    expect(source).toContain('setEnabledEmitterIds(nextEnabledEmitterIds');
    expect(source).toContain('deriveVfxPreviewBounds(effect.program.emitters)');
    expect(source).toContain('previewViewport.frameBounds(previewBounds)');
    expect(source).toContain('previewRuntime.enabledEmitterIdSet.has(emitter.id)');
    expect(source).toContain("name: 'vfx-preview-authored-bounds'");
    expect(source).toContain('drawVfxPreviewBounds(');
    expect(source).toContain('vfx-preview-debug-draw-unavailable');
    expect(source).toContain('seekPhaseTick(targetPhaseTick');
    expect(source).toContain('currentApp.stepFrame(fixedDelta)');
    expect(source).toContain('currentApp.pause().unwrap()');
    expect(source).toContain('currentApp.resume().unwrap()');
    expect(source).not.toContain('gateway.dispatch');
    expect(source).not.toContain('registerVfxPreviewController');
    expect(source).not.toContain('autoReplayIntervalMs');
    expect(source).not.toContain('currentApp.world.update(');
    expect(source).not.toContain('currentApp.renderer.draw(');
  });

  it('routes toolbar and AI through the same Runtime-owned transient operations', () => {
    expect(source).toContain('dispatchViewportRuntimeOperation(operationId');
    expect(source).toContain('VFX_PREVIEW_OPERATION_IDS.play');
    expect(source).toContain('VFX_PREVIEW_OPERATION_IDS.pause');
    expect(source).toContain('VFX_PREVIEW_OPERATION_IDS.reset');
    expect(source).toContain('VFX_PREVIEW_OPERATION_IDS.seek');
    expect(source).toContain('VFX_PREVIEW_OPERATION_IDS.setEmitterMask');
    expect(source).toContain('VFX_PREVIEW_OPERATION_IDS.frameBounds');
    expect(source).toContain('VFX_PREVIEW_OPERATION_IDS.setBoundsVisible');
    expect(source).not.toContain('runtimeRef.current?.setPlaying');
    expect(source).not.toContain('runtimeRef.current?.replay');
    expect(source).not.toContain('runtime.seekPhaseTick(phaseTick)');
  });
});
