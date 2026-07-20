import { describe, expect, it, mock } from 'bun:test';
import { createCapabilityRegistry } from './capabilities';
import { createExtensionLoader } from './loader';
import type { ExtensionManifest } from './types';

type Cap = 'a' | 'b' | 'c';

interface Ctx { host: { extend: (c: Cap) => void }; log: unknown }

function makeCtx(caps: ReturnType<typeof createCapabilityRegistry<Cap>>): (m: ExtensionManifest<Cap, Ctx>) => Ctx {
  return () => ({
    host: { extend: (c) => caps.add(c) },
    log: null,
  });
}

describe('ExtensionLoader', () => {
  it('activates plugins whose requires are satisfied; skips others until deps arrive', async () => {
    const caps = createCapabilityRegistry<Cap>();
    const loader = createExtensionLoader<Ctx, Cap>({ capabilities: caps, contextFactory: makeCtx(caps), devMode: false });
    const seq: string[] = [];
    const p1: ExtensionManifest<Cap, Ctx> = {
      id: 'p1', version: '1', provides: ['a'],
      setup: (ctx) => { ctx.host.extend('a'); seq.push('p1'); return () => { seq.push('p1-cleanup'); }; },
    };
    const p2: ExtensionManifest<Cap, Ctx> = {
      id: 'p2', version: '1', requires: ['a'], provides: ['b'],
      setup: (ctx) => { ctx.host.extend('b'); seq.push('p2'); },
    };
    await loader.load([p2, p1]);
    await loader.flush();
    expect(seq).toEqual(['p1', 'p2']);   // p1 first even though declared second
    expect(caps.has('b')).toBe(true);
  });

  it('cleanup runs in reverse activation order on unload', async () => {
    const caps = createCapabilityRegistry<Cap>();
    const loader = createExtensionLoader<Ctx, Cap>({ capabilities: caps, contextFactory: makeCtx(caps), devMode: false });
    const seq: string[] = [];
    await loader.load([
      { id: 'p1', version: '1', provides: ['a'], setup: (ctx) => { ctx.host.extend('a'); return () => { seq.push('p1'); }; } },
      { id: 'p2', version: '1', requires: ['a'], setup: () => () => { seq.push('p2'); } },
    ]);
    await loader.flush();
    await loader.unload();
    expect(seq).toEqual(['p2', 'p1']);
  });

  it('setup exception is reported via onError and does not activate the plugin', async () => {
    const caps = createCapabilityRegistry<Cap>();
    const errs: string[] = [];
    const loader = createExtensionLoader<Ctx, Cap>({
      capabilities: caps, contextFactory: makeCtx(caps), devMode: false,
      onError: (err, m, phase) => errs.push(`${m.id}:${phase}`),
    });
    await loader.load([{ id: 'bad', version: '1', setup: () => { throw new Error('nope'); } }]);
    await loader.flush();
    expect(errs).toEqual(['bad:setup']);
    expect(loader.getActive().length).toBe(0);
  });

  it('a plugin remains pending when requires not yet met; activates when cap arrives', async () => {
    const caps = createCapabilityRegistry<Cap>();
    const loader = createExtensionLoader<Ctx, Cap>({ capabilities: caps, contextFactory: makeCtx(caps), devMode: false });
    let ranP2 = false;
    await loader.load([{ id: 'p2', version: '1', requires: ['a'], setup: () => { ranP2 = true; } }]);
    await loader.flush();
    expect(ranP2).toBe(false);
    expect(loader.getPending().map((m) => m.id)).toEqual(['p2']);
    caps.add('a');
    await loader.flush();
    expect(ranP2).toBe(true);
  });

  it('reload after unload starts fresh (no residual state)', async () => {
    const caps = createCapabilityRegistry<Cap>();
    const seq: string[] = [];
    const loader = createExtensionLoader<Ctx, Cap>({ capabilities: caps, contextFactory: makeCtx(caps), devMode: false });
    const p1: ExtensionManifest<Cap, Ctx> = {
      id: 'p1', version: '1', provides: ['a'],
      setup: (ctx) => { ctx.host.extend('a'); seq.push('setup:p1'); return () => { seq.push('cleanup:p1'); }; },
    };
    await loader.load([p1]);
    await loader.flush();
    await loader.unload();
    expect(seq).toEqual(['setup:p1', 'cleanup:p1']);
    // Reload the same plugin — activation must fire again and pending/active state
    // must reflect only this second run (not accumulate from the first).
    await loader.load([p1]);
    await loader.flush();
    expect(seq).toEqual(['setup:p1', 'cleanup:p1', 'setup:p1']);
    expect(loader.getActive().map((m) => m.id)).toEqual(['p1']);
    expect(loader.getPending()).toHaveLength(0);
  });

  it('capability bounce deactivates the dependent then reactivates when cap returns', async () => {
    const caps = createCapabilityRegistry<Cap>();
    const seq: string[] = [];
    const loader = createExtensionLoader<Ctx, Cap>({ capabilities: caps, contextFactory: makeCtx(caps), devMode: false });
    const p2: ExtensionManifest<Cap, Ctx> = {
      id: 'p2', version: '1', requires: ['a'],
      setup: () => { seq.push('setup'); return () => { seq.push('cleanup'); }; },
    };
    caps.add('a');
    await loader.load([p2]);
    await loader.flush();
    expect(seq).toEqual(['setup']);
    caps.remove('a');
    await loader.flush();
    expect(seq).toEqual(['setup', 'cleanup']);
    expect(loader.getActive()).toHaveLength(0);
    expect(loader.getPending().map((m) => m.id)).toEqual(['p2']);
    caps.add('a');
    await loader.flush();
    expect(seq).toEqual(['setup', 'cleanup', 'setup']);
    expect(loader.getActive().map((m) => m.id)).toEqual(['p2']);
  });
});
