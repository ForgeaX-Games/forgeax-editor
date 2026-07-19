// L1 跨-app 事件总线 primitive —— 纯机制，零 app 语义。
//
// 设计意图（R5 store 收敛）：interface 是 L1 AppKit，不认识任何上层 app 的 topic。
// 各 app 通过 TS declaration merging 往 `BusTopics` 里登记自己的 topic → payload
// 类型；L1 只提供 publish / subscribe 机制本身。这样「新增 app 不改 L1」——app 自带
// 自己的 topic 声明即可。
//
// 两种用法：
//   1. 意图 (fire-and-forget)：`publish('overlay:open', { id })` → 当前订阅者收到，
//      不留存。用于跨 app 导航/深链意图（原 store 里的 ~14 个 pending* 槽）。
//   2. 只读真值快照：`publish('sessions:changed', snap, { retain: true })` → 留存最近
//      一次值；之后 subscribe 的新订阅者**立即**收到该值。用于 owner app 广播共享真值、
//      其他 app 存只读副本（原 store 里 tabs / liveAgents 等跨 app 读的状态）。
//
// HMR 安全：handler 表 + retained 表挂在 globalThis 上，模块被重新求值时不丢订阅、
// 不丢最近快照。

/** app 侧声明合并登记自己的 topic。L1 保持为空 —— 它不认识任何具体 topic。
 *
 *  app 侧示例（放在 app 自己的包里，不进 interface）：
 *    declare module '@forgeax/interface/lib/bus' {
 *      interface BusTopics { 'sessions:changed': SessionsSnapshot }
 *    }
 */
export interface BusTopics {}

/** 已知 topic 给补全，同时允许任意 string（不强制每个 topic 都先登记类型）。 */
type TopicName = keyof BusTopics | (string & {});
type PayloadOf<K> = K extends keyof BusTopics ? BusTopics[K] : unknown;

type AnyHandler = (payload: unknown) => void;

interface BusState {
  handlers: Map<string, Set<AnyHandler>>;
  retained: Map<string, unknown>;
}

const _BUS_FLAG = '__FORGEAX_BUS__';
type WithBus = { [_BUS_FLAG]?: BusState };
const _gt = globalThis as unknown as WithBus;
const _bus: BusState =
  _gt[_BUS_FLAG] ?? (_gt[_BUS_FLAG] = { handlers: new Map(), retained: new Map() });

/** 发布一条 topic。
 *  @param opts.retain 留存本次 payload；之后新订阅者会立即收到（快照语义）。默认 false（纯意图）。 */
export function publish<K extends TopicName>(
  topic: K,
  payload: PayloadOf<K>,
  opts?: { retain?: boolean },
): void {
  if (opts?.retain) _bus.retained.set(topic, payload);
  const set = _bus.handlers.get(topic);
  if (!set) return;
  for (const h of [...set]) {
    try {
      h(payload as unknown);
    } catch (err) {
      console.warn(`[bus] handler for "${topic}" threw`, err);
    }
  }
}

/** 订阅一条 topic，返回 unsubscribe。
 *  若该 topic 有 retained 快照，handler 会被**同步立即**调用一次（补齐当前值）。 */
export function subscribe<K extends TopicName>(
  topic: K,
  handler: (payload: PayloadOf<K>) => void,
): () => void {
  const h = handler as AnyHandler;
  let set = _bus.handlers.get(topic);
  if (!set) {
    set = new Set();
    _bus.handlers.set(topic, set);
  }
  set.add(h);
  if (_bus.retained.has(topic)) {
    try {
      h(_bus.retained.get(topic));
    } catch (err) {
      console.warn(`[bus] replay for "${topic}" threw`, err);
    }
  }
  return () => {
    const s = _bus.handlers.get(topic);
    if (s) {
      s.delete(h);
      if (s.size === 0) _bus.handlers.delete(topic);
    }
  };
}

/** 读取某 topic 最近一次 retained 快照（无则 undefined）。给「订阅前先取一次当前值」用。 */
export function peek<K extends TopicName>(topic: K): PayloadOf<K> | undefined {
  return _bus.retained.get(topic) as PayloadOf<K> | undefined;
}

/** 清掉某 topic 的 retained 快照（owner app 卸载共享真值时用）。 */
export function clearRetained(topic: TopicName): void {
  _bus.retained.delete(topic);
}
