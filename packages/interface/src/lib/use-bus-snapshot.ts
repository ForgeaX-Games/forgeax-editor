// L1 bus 的 React 读侧 —— 订阅某 topic 的 retained 快照，随 owner 发布重渲染。
//
// 配套 `bus.ts`：owner app 用 `publish(topic, snap, { retain: true })` 广播只读真值，
// 壳骨架 / 其他 app 用 `useBusSnapshot(topic)` 读一份响应式只读副本 —— 无需直读
// owner 的 store（保持 L1 对 app 领域态零知识）。
//
// 注意：owner 每次变更必须发布**新的对象引用**（快照语义），否则 useSyncExternalStore
// 认为未变、不重渲染。返回 `undefined` 表示 owner 尚未发布过（消费者自行 `?? 缺省`）。

import { useSyncExternalStore } from 'react';
import { peek, subscribe, type BusTopics } from './bus';

export function useBusSnapshot<K extends keyof BusTopics>(topic: K): BusTopics[K] | undefined;
export function useBusSnapshot(topic: string): unknown;
export function useBusSnapshot(topic: string): unknown {
  return useSyncExternalStore(
    (onChange) => subscribe(topic as keyof BusTopics, () => onChange()),
    () => peek(topic as keyof BusTopics),
    () => peek(topic as keyof BusTopics),
  );
}
