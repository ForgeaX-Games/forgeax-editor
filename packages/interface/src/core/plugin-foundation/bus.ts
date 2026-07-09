// packages/interface/src/core/plugin-foundation/bus.ts
//
// Synchronous typed pub/sub with middleware chain. Copied from arrival's
// plugin-foundation/bus.ts — see docs/comm-mechanism-analysis-2026-07-09.md
// §3.4.
import type {
  BusEvent,
  EventMap,
  Listener,
  ListenerErrorHandler,
  Middleware,
} from './types';

export interface EventBusOptions<E extends EventMap> {
  readonly onListenerError?: ListenerErrorHandler<E>;
}

export class EventBus<E extends EventMap> {
  private readonly listeners = new Map<keyof E, Set<Listener<unknown>>>();
  private readonly middlewares: Middleware<E>[] = [];
  private readonly onListenerError: ListenerErrorHandler<E>;
  private destroyed = false;

  constructor(opts: EventBusOptions<E> = {}) {
    this.onListenerError =
      opts.onListenerError ??
      ((err, topic, payload) =>
        console.error(
          `[plugin-foundation] EventBus listener for "${String(topic)}" threw`,
          err,
          { payload },
        ));
  }

  on<K extends keyof E>(topic: K, listener: Listener<E[K]>): () => void {
    this.assertAlive('on');
    let set = this.listeners.get(topic);
    if (!set) { set = new Set(); this.listeners.set(topic, set); }
    set.add(listener as Listener<unknown>);
    return () => this.off(topic, listener);
  }

  off<K extends keyof E>(topic: K, listener: Listener<E[K]>): void {
    const set = this.listeners.get(topic);
    if (!set) return;
    set.delete(listener as Listener<unknown>);
    if (set.size === 0) this.listeners.delete(topic);
  }

  emit<K extends keyof E>(topic: K, payload: E[K]): void {
    if (this.destroyed) return;
    const event: BusEvent<E, K> = { topic, payload };
    this.runChain(0, event as BusEvent<E>);
  }

  use(middleware: Middleware<E>): () => void {
    this.assertAlive('use');
    this.middlewares.push(middleware);
    return () => {
      const i = this.middlewares.indexOf(middleware);
      if (i >= 0) this.middlewares.splice(i, 1);
    };
  }

  listenerCount(topic?: keyof E): number {
    if (topic !== undefined) return this.listeners.get(topic)?.size ?? 0;
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }

  destroy(): void {
    this.listeners.clear();
    this.middlewares.length = 0;
    this.destroyed = true;
  }

  private runChain(index: number, event: BusEvent<E>): void {
    if (index < this.middlewares.length) {
      const mw = this.middlewares[index];
      let nextCalled = false;
      try {
        mw(event, (next) => {
          nextCalled = true;
          this.runChain(index + 1, next);
        });
      } catch (err) {
        try { this.onListenerError(err, event.topic, event.payload); } catch { /* ignore */ }
        if (!nextCalled) this.runChain(index + 1, event);
      }
      return;
    }
    this.dispatch(event);
  }

  private dispatch(event: BusEvent<E>): void {
    const set = this.listeners.get(event.topic);
    if (!set) return;
    const snapshot = Array.from(set);
    for (const listener of snapshot) {
      try {
        listener(event.payload);
      } catch (err) {
        try { this.onListenerError(err, event.topic, event.payload); } catch { /* ignore */ }
      }
    }
  }

  private assertAlive(method: 'on' | 'use'): void {
    if (this.destroyed) {
      throw new Error(`[plugin-foundation] EventBus.${method}() called on a destroyed bus`);
    }
  }
}
