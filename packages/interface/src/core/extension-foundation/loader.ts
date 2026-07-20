// packages/interface/src/core/extension-foundation/loader.ts
//
// Copied from arrival's extension-foundation/loader.ts. See spec §4 for the
// pending / capability-driven-reactivation semantics.
import type { CapabilityRegistry } from './capabilities';
import { ExtensionSetupError } from './errors';
import type { Cleanup, ExtensionManifest } from './types';

const PENDING_WARN_DELAY_MS = 30_000;

export interface ExtensionLoaderOptions<Ctx, C extends string> {
  readonly capabilities: CapabilityRegistry<C>;
  readonly contextFactory: (manifest: ExtensionManifest<C, Ctx>) => Ctx;
  readonly onError?: (err: ExtensionSetupError, manifest: ExtensionManifest<C, Ctx>, phase: 'setup' | 'cleanup') => void;
  readonly devMode?: boolean;
}

export interface ExtensionLoader<Ctx, C extends string> {
  load(manifests: ReadonlyArray<ExtensionManifest<C, Ctx>>): Promise<void>;
  unload(): Promise<void>;
  getPending(): ReadonlyArray<ExtensionManifest<C, Ctx>>;
  getActive(): ReadonlyArray<ExtensionManifest<C, Ctx>>;
  flush(): Promise<void>;
}

interface ActiveRecord<Ctx, C extends string> {
  readonly manifest: ExtensionManifest<C, Ctx>;
  readonly cleanup: Cleanup | undefined;
  readonly order: number;
}

export function createExtensionLoader<Ctx, C extends string>(
  opts: ExtensionLoaderOptions<Ctx, C>,
): ExtensionLoader<Ctx, C> {
  const { capabilities, contextFactory, onError, devMode = false } = opts;
  const pending = new Map<string, ExtensionManifest<C, Ctx>>();
  const active = new Map<string, ActiveRecord<Ctx, C>>();
  const activeOrder: string[] = [];
  const declarationOrder = new Map<string, number>();
  const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let opChain: Promise<void> = Promise.resolve();
  let capAddedUnsub: (() => void) | undefined;
  let capRemovedUnsub: (() => void) | undefined;
  let nextOrder = 0;

  function enqueue(work: () => Promise<void>): Promise<void> {
    const next = opChain.then(work).catch((err) => {
      console.error('[extension-foundation] internal opChain error (should not happen — onError catches setup/cleanup)', err);
    });
    opChain = next;
    return next;
  }

  function requiresSatisfied(m: ExtensionManifest<C, Ctx>): boolean {
    if (!m.requires || m.requires.length === 0) return true;
    for (const r of m.requires) if (!capabilities.has(r)) return false;
    return true;
  }

  function firstReadyPending(): ExtensionManifest<C, Ctx> | undefined {
    let best: ExtensionManifest<C, Ctx> | undefined;
    let bestOrder = Infinity;
    for (const m of pending.values()) {
      if (!requiresSatisfied(m)) continue;
      const o = declarationOrder.get(m.id) ?? Infinity;
      if (o < bestOrder) { best = m; bestOrder = o; }
    }
    return best;
  }

  async function runCleanup(rec: ActiveRecord<Ctx, C>): Promise<void> {
    if (!rec.cleanup) return;
    try { await rec.cleanup(); }
    catch (cause) {
      const err = new ExtensionSetupError({ extensionId: rec.manifest.id, phase: 'cleanup', cause });
      onError?.(err, rec.manifest, 'cleanup') ?? console.error(err);
    }
  }

  async function activateOne(m: ExtensionManifest<C, Ctx>): Promise<void> {
    let cleanup: Cleanup | undefined;
    try {
      const ctx = contextFactory(m);
      const result = await m.setup(ctx);
      if (typeof result === 'function') cleanup = result as Cleanup;
    } catch (cause) {
      const err = new ExtensionSetupError({ extensionId: m.id, phase: 'setup', cause });
      onError?.(err, m, 'setup') ?? console.error(err);
      return;
    }
    const order = nextOrder++;
    active.set(m.id, { manifest: m, cleanup, order });
    activeOrder.push(m.id);
    if (m.provides) for (const c of m.provides) capabilities.add(c);
  }

  async function scanAndActivate(): Promise<void> {
    while (true) {
      const candidate = firstReadyPending();
      if (!candidate) return;
      pending.delete(candidate.id);
      const t = pendingTimers.get(candidate.id);
      if (t) { clearTimeout(t); pendingTimers.delete(candidate.id); }
      await activateOne(candidate);
    }
  }

  async function handleCapabilityRemoved(cap: C): Promise<void> {
    const victims: ActiveRecord<Ctx, C>[] = [];
    for (const id of activeOrder) {
      const rec = active.get(id);
      if (rec?.manifest.requires?.includes(cap)) victims.push(rec);
    }
    if (victims.length === 0) return;
    for (const rec of victims.slice().sort((a, b) => b.order - a.order)) {
      await runCleanup(rec);
      active.delete(rec.manifest.id);
      const idx = activeOrder.indexOf(rec.manifest.id);
      if (idx >= 0) activeOrder.splice(idx, 1);
      pending.set(rec.manifest.id, rec.manifest);
      if (devMode) {
        const existing = pendingTimers.get(rec.manifest.id);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          const missing = (rec.manifest.requires ?? []).filter((c) => !capabilities.has(c));
          console.warn(`[extension-foundation] plugin "${rec.manifest.id}" pending >${PENDING_WARN_DELAY_MS}ms; missing: ${JSON.stringify(missing)}`);
          pendingTimers.delete(rec.manifest.id);
        }, PENDING_WARN_DELAY_MS);
        pendingTimers.set(rec.manifest.id, timer);
      }
    }
  }

  return {
    load(manifests) {
      if (!capAddedUnsub) {
        capAddedUnsub = capabilities.on('added', () => { enqueue(() => scanAndActivate()); });
        capRemovedUnsub = capabilities.on('removed', (cap) => { enqueue(() => handleCapabilityRemoved(cap)); });
      }
      for (const m of manifests) {
        if (declarationOrder.has(m.id) || active.has(m.id)) continue;
        declarationOrder.set(m.id, declarationOrder.size);
        pending.set(m.id, m);
        if (devMode) {
          const timer = setTimeout(() => {
            const missing = (m.requires ?? []).filter((c) => !capabilities.has(c));
            console.warn(`[extension-foundation] plugin "${m.id}" pending >${PENDING_WARN_DELAY_MS}ms; missing: ${JSON.stringify(missing)}`);
            pendingTimers.delete(m.id);
          }, PENDING_WARN_DELAY_MS);
          pendingTimers.set(m.id, timer);
        }
      }
      return enqueue(() => scanAndActivate());
    },
    unload() {
      return enqueue(async () => {
        for (const id of pending.keys()) {
          const t = pendingTimers.get(id);
          if (t) { clearTimeout(t); pendingTimers.delete(id); }
        }
        pending.clear();
        const order = [...activeOrder].reverse();
        for (const id of order) {
          const rec = active.get(id);
          if (!rec) continue;
          await runCleanup(rec);
          active.delete(id);
        }
        activeOrder.length = 0;
        declarationOrder.clear();
        nextOrder = 0;
        capAddedUnsub?.(); capRemovedUnsub?.();
        capAddedUnsub = undefined; capRemovedUnsub = undefined;
      });
    },
    getPending() { return [...pending.values()]; },
    getActive() {
      return activeOrder
        .map((id) => active.get(id)?.manifest)
        .filter((m): m is ExtensionManifest<C, Ctx> => m !== undefined);
    },
    flush() { return opChain; },
  };
}
