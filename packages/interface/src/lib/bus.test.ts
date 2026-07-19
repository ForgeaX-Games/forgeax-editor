/**
 * L1 跨-app 总线 primitive 行为契约。纯（无 DOM）。
 * 锁三件事：意图 fire-and-forget、retain 快照对新订阅者立即补发、unsubscribe 生效。
 */
import { describe, it, expect } from 'bun:test';
import { publish, subscribe, peek, clearRetained } from './bus';

describe('bus primitive', () => {
  it('publish → 当前订阅者收到；后订阅者收不到历史（非 retain）', () => {
    const got: number[] = [];
    const off = subscribe<'t:intent'>('t:intent' as never, (p) => got.push(p as unknown as number));
    publish('t:intent' as never, 1 as never);
    publish('t:intent' as never, 2 as never);
    // 意图不 retain：迟到订阅者拿不到历史
    const late: number[] = [];
    const offLate = subscribe('t:intent' as never, (p) => late.push(p as unknown as number));
    expect(got).toEqual([1, 2]);
    expect(late).toEqual([]);
    off();
    offLate();
  });

  it('retain 快照：新订阅者立即同步收到最近值', () => {
    publish('t:snap' as never, { n: 42 } as never, { retain: true });
    let received: { n: number } | null = null;
    const off = subscribe('t:snap' as never, (p) => { received = p as { n: number }; });
    expect(received).toEqual({ n: 42 });
    expect(peek('t:snap' as never)).toEqual({ n: 42 } as never);
    off();
    clearRetained('t:snap' as never);
    expect(peek('t:snap' as never)).toBeUndefined();
  });

  it('unsubscribe 后不再收到', () => {
    const got: number[] = [];
    const off = subscribe('t:off' as never, (p) => got.push(p as unknown as number));
    publish('t:off' as never, 1 as never);
    off();
    publish('t:off' as never, 2 as never);
    expect(got).toEqual([1]);
  });

  it('一个 handler 抛错不影响其他 handler', () => {
    const got: string[] = [];
    const offA = subscribe('t:multi' as never, () => { throw new Error('boom'); });
    const offB = subscribe('t:multi' as never, () => { got.push('b'); });
    publish('t:multi' as never, null as never);
    expect(got).toEqual(['b']);
    offA();
    offB();
  });
});
