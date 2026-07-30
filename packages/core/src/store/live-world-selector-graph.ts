import {
  normalizeSelectorValue,
  selectorValuesEqual,
  type NormalizedSelectorValue,
  type SelectorValueSchema,
} from './live-world-selectors';

export interface MountedSelector<T> {
  readonly key: string;
  readonly schema: SelectorValueSchema;
  readonly read: (world: unknown) => T;
  readonly normalize?: (value: T) => NormalizedSelectorValue;
  readonly equal?: (left: unknown, right: unknown) => boolean;
}

export interface SelectorSubscription<T> {
  getSnapshot(): T | undefined;
  subscribe(listener: () => void): () => void;
  unsubscribe(): void;
}

export interface SelectorGraphStats {
  readonly status: 'bound' | 'unbound' | 'disposed';
  readonly worldGeneration: number;
  readonly cacheEntries: number;
  readonly listeners: number;
  readonly snapshotBytes: number;
  readonly frameOpportunity: number;
  readonly domainPublishCount: number;
  readonly stalePublishes: number;
}

type Entry = {
  readonly selector: MountedSelector<unknown>;
  readonly subscriptions: Set<() => void>;
  refs: number;
  normalized?: NormalizedSelectorValue;
};

export type PublishResult = 'published' | 'unbound' | 'stale' | 'disposed';

export class LiveWorldSelectorGraph {
  private activeWorld: unknown | null = null;
  private generation = 0;
  private state: SelectorGraphStats['status'] = 'unbound';
  private readonly entries = new Map<string, Entry>();
  private frameCount = 0;
  private publishCount = 0;
  private staleCount = 0;

  bindWorld(world: unknown): number {
    if (this.state === 'disposed') return this.generation;
    if (this.activeWorld === world && this.state === 'bound') return this.generation;
    this.clearEntries();
    this.activeWorld = world;
    this.generation += 1;
    this.state = 'bound';
    return this.generation;
  }

  unbindWorld(expectedWorld?: unknown): boolean {
    if (this.state === 'disposed') return false;
    if (expectedWorld !== undefined && expectedWorld !== this.activeWorld) return false;
    if (this.state === 'unbound') return true;
    this.clearEntries();
    this.activeWorld = null;
    this.generation += 1;
    this.state = 'unbound';
    return true;
  }

  mount<T>(selector: MountedSelector<T>): SelectorSubscription<T> {
    if (this.state === 'disposed') {
      return { getSnapshot: () => undefined, subscribe: () => () => undefined, unsubscribe: () => undefined };
    }
    let entry = this.entries.get(selector.key);
    if (!entry) {
      entry = { selector: selector as MountedSelector<unknown>, subscriptions: new Set(), refs: 0 };
      this.entries.set(selector.key, entry);
    }
    entry.refs += 1;
    let released = false;
    const subscription: SelectorSubscription<T> = {
      getSnapshot: () => entry?.normalized?.snapshot as T | undefined,
      subscribe: (listener) => {
        if (released) return () => undefined;
        entry?.subscriptions.add(listener);
        return () => entry?.subscriptions.delete(listener);
      },
      unsubscribe: () => {
        if (released) return;
        released = true;
        if (entry) {
          entry.refs -= 1;
          if (entry.refs === 0) {
            entry.subscriptions.clear();
            this.entries.delete(selector.key);
          }
        }
      },
    };
    return subscription;
  }

  publish(options: { readonly world?: unknown; readonly worldGeneration?: number } = {}): PublishResult {
    if (this.state === 'disposed') return 'disposed';
    this.frameCount += 1;
    if (options.world !== undefined && options.world !== this.activeWorld) {
      this.staleCount += 1;
      return 'stale';
    }
    if (options.worldGeneration !== undefined && options.worldGeneration !== this.generation) {
      this.staleCount += 1;
      return 'stale';
    }
    if (this.state !== 'bound' || this.activeWorld === null) return 'unbound';

    this.publishCount += 1;
    for (const entry of this.entries.values()) {
      let normalized: NormalizedSelectorValue;
      try {
        const value = entry.selector.read(this.activeWorld);
        normalized = entry.selector.normalize
          ? entry.selector.normalize(value)
          : normalizeSelectorValue(value, entry.selector.schema);
      } catch {
        continue;
      }
      const changed = entry.normalized === undefined || !(entry.selector.equal
        ? entry.selector.equal(entry.normalized.snapshot, normalized.snapshot)
        : selectorValuesEqual(entry.normalized.snapshot, normalized.snapshot, entry.selector.schema));
      if (!changed) continue;
      entry.normalized = normalized;
      for (const listener of [...entry.subscriptions]) {
        try { listener(); } catch { /* one subscriber cannot block graph cleanup */ }
      }
    }
    return 'published';
  }

  stats(): SelectorGraphStats {
    let listeners = 0;
    let bytes = 0;
    for (const entry of this.entries.values()) {
      listeners += entry.refs;
      bytes += entry.normalized?.bytes ?? 0;
    }
    return {
      status: this.state,
      worldGeneration: this.generation,
      cacheEntries: this.entries.size,
      listeners,
      snapshotBytes: bytes,
      frameOpportunity: this.frameCount,
      domainPublishCount: this.publishCount,
      stalePublishes: this.staleCount,
    };
  }

  dispose(): void {
    if (this.state === 'disposed') return;
    this.clearEntries();
    this.activeWorld = null;
    this.state = 'disposed';
  }

  private clearEntries(): void {
    for (const entry of this.entries.values()) entry.subscriptions.clear();
    this.entries.clear();
  }
}
