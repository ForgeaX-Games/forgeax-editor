// packages/interface/src/core/extension-foundation/capabilities.ts
//
// Observable capability set. Copied from arrival's extension-foundation/
// capabilities.ts.
import { EventBus } from './bus';
import type { Cleanup } from './types';

export type CapabilityEventName = 'added' | 'removed';

export interface CapabilityRegistry<C extends string> {
  add(capability: C): void;
  remove(capability: C): void;
  has(capability: C): boolean;
  snapshot(): ReadonlySet<C>;
  on(event: CapabilityEventName, listener: (capability: C) => void): Cleanup;
}

interface CapEvents<C extends string> extends Record<string, unknown> {
  added: C;
  removed: C;
}

export function createCapabilityRegistry<C extends string>(): CapabilityRegistry<C> {
  const set = new Set<C>();
  const bus = new EventBus<CapEvents<C>>();
  return {
    add(c) { if (set.has(c)) return; set.add(c); bus.emit('added', c); },
    remove(c) { if (!set.has(c)) return; set.delete(c); bus.emit('removed', c); },
    has(c) { return set.has(c); },
    snapshot() {
      const copy = new Set<C>(set);
      const reject = (op: string) => () => {
        throw new TypeError(`[extension-foundation] snapshot() is read-only; ${op}() rejected`);
      };
      copy.add = reject('add') as typeof copy.add;
      copy.delete = reject('delete') as typeof copy.delete;
      copy.clear = reject('clear') as typeof copy.clear;
      return copy;
    },
    on(event, listener) { return bus.on(event, listener); },
  };
}
