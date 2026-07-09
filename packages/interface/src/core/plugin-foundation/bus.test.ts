import { describe, expect, it, mock } from 'bun:test';
import { EventBus } from './bus';

interface M {
  'foo': { n: number };
  'bar': string;
}

describe('EventBus', () => {
  it('emits typed payloads to matching listeners only', () => {
    const bus = new EventBus<M>();
    const onFoo = mock((_: { n: number }) => {});
    const onBar = mock((_: string) => {});
    bus.on('foo', onFoo);
    bus.on('bar', onBar);
    bus.emit('foo', { n: 1 });
    expect(onFoo).toHaveBeenCalledWith({ n: 1 });
    expect(onBar).not.toHaveBeenCalled();
  });

  it('unsubscribe function stops delivery', () => {
    const bus = new EventBus<M>();
    const listener = mock((_: string) => {});
    const off = bus.on('bar', listener);
    off();
    bus.emit('bar', 'x');
    expect(listener).not.toHaveBeenCalled();
  });

  it('middleware may intercept and stop propagation', () => {
    const bus = new EventBus<M>();
    const listener = mock((_: string) => {});
    bus.on('bar', listener);
    bus.use((_ev, _next) => { /* intentionally do not call next */ });
    bus.emit('bar', 'x');
    expect(listener).not.toHaveBeenCalled();
  });

  it('listener exception does not kill sibling listeners', () => {
    const errors: unknown[] = [];
    const bus = new EventBus<M>({ onListenerError: (err) => errors.push(err) });
    const goodListener = mock((_: string) => {});
    bus.on('bar', () => { throw new Error('boom'); });
    bus.on('bar', goodListener);
    bus.emit('bar', 'x');
    expect(errors).toHaveLength(1);
    expect(goodListener).toHaveBeenCalled();
  });

  it('destroy silently ignores subsequent emit; on() throws', () => {
    const bus = new EventBus<M>();
    bus.destroy();
    expect(() => bus.emit('bar', 'x')).not.toThrow();
    expect(() => bus.on('bar', () => {})).toThrow(/destroyed/);
  });

  it('middleware exception is delivered to onListenerError and chain auto-advances', () => {
    const errors: unknown[] = [];
    const bus = new EventBus<M>({ onListenerError: (err) => errors.push(err) });
    const listener = mock((_: string) => {});
    bus.use(() => { throw new Error('mw-boom'); });
    bus.on('bar', listener);
    bus.emit('bar', 'x');
    expect(errors).toHaveLength(1);
    expect(listener).toHaveBeenCalledWith('x');
  });

  it('middleware exception after next() does NOT re-run downstream', () => {
    const bus = new EventBus<M>({ onListenerError: () => {} });
    const listener = mock((_: string) => {});
    bus.use((ev, next) => { next(ev); throw new Error('after-next'); });
    bus.on('bar', listener);
    bus.emit('bar', 'x');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('use() returns an unsubscribe that removes only that middleware', () => {
    const bus = new EventBus<M>();
    const listener = mock((_: string) => {});
    bus.on('bar', listener);
    const off = bus.use((_ev, _next) => { /* blocks */ });
    bus.emit('bar', 'x');
    expect(listener).not.toHaveBeenCalled();
    off();
    bus.emit('bar', 'y');
    expect(listener).toHaveBeenCalledWith('y');
  });

  it('listenerCount reports per-topic and total', () => {
    const bus = new EventBus<M>();
    expect(bus.listenerCount()).toBe(0);
    expect(bus.listenerCount('bar')).toBe(0);
    bus.on('bar', () => {});
    bus.on('bar', () => {});
    bus.on('foo', () => {});
    expect(bus.listenerCount('bar')).toBe(2);
    expect(bus.listenerCount('foo')).toBe(1);
    expect(bus.listenerCount()).toBe(3);
  });
});
