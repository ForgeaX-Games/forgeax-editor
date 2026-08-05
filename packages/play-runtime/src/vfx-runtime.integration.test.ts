// M3 integration contract: independent Play consumes the engine public
// ParticleRuntimeHost, while compiler/importer code remains build-time only.
// Anchors: requirements AC-02/AC-03/AC-08, plan-strategy §2 D-1/D-5 and §7 M3.

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { World } from '@forgeax/engine-ecs';
import { createPlayVfxRuntime } from './vfx-runtime';

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
}

describe('independent Play VFX runtime', () => {
  it('attaches the cooked asset world through one public host and exposes readiness', async () => {
    const attached: Array<{ world: World; assets: object }> = [];
    const detached: World[] = [];
    const host = {
      feature: { diagnostics: () => ({ readiness: 'ready', bucketCount: 1 }) },
      async attachWorld(input: { world: World; assets: object }) {
        attached.push(input);
        return { ok: true as const, value: { state: 'attached' as const } };
      },
      detachWorld(input: { world: World }) {
        detached.push(input.world);
        return { ok: true as const, value: { state: 'detached' as const } };
      },
    };
    const runtime = createPlayVfxRuntime({
      world: () => attached[0]?.world,
      hostFactory: () => host as never,
    });
    const world = new World();
    const assets = { cooked: true };

    expect((await runtime.attachWorld(world, assets as never)).ok).toBe(true);
    expect(attached).toEqual([{ world, assets }]);
    expect(runtime.readiness()).toMatchObject({ readiness: 'ready' });
    expect(runtime.detachWorld(world).ok).toBe(true);
    expect(detached).toEqual([world]);
  });

  it('keeps compiler out of the runtime graph and preserves the VAG boundary', () => {
    const main = source('./main.ts');
    const runtime = source('./vfx-runtime.ts');
    const pkg = JSON.parse(source('../package.json')) as { dependencies: Record<string, string> };
    expect(main).toContain('createPlayVfxRuntime');
    expect(main).toContain('vfxRuntime.host.feature');
    expect(main).toContain('vfxRuntime.attachWorld');
    expect(main).not.toMatch(/from ['"]@forgeax\/engine-vfx-(?:compiler|render)\/internal/);
    expect(main).not.toMatch(/from ['"]@forgeax\/editor-core['"]/);
    expect(runtime).toContain("from '@forgeax/engine-vfx-render'");
    expect(runtime).not.toContain('@forgeax/engine-vfx-compiler');
    expect(pkg.dependencies['@forgeax/engine-vfx-render']).toBeDefined();
  });
});
