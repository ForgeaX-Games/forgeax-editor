// 跨-surface 深链意图 —— 建在 L1 bus primitive 之上的一层薄封装（R5/P2）。
//
// 背景：原来这些"点了 A 面里的东西 → 跳到 B 面并高亮/展开/过滤"的意图，是往 L1
// store 里塞 `pending*` 字段（producer set、consumer 读到后 act + 清空）实现的。
// 那让 L1 store 变成了跨 app 导航总线（app 领域态漏进 L1）。R5/P2 把它们改成走 bus：
//   - producer：`emitDeepLink(topic, payload)`  —— retain 一次（快照语义）
//   - consumer：`useDeepLink(topic)` → [value, clear]，clear 时清 retained + 本地
//
// 为什么 retain：这些深链常跨一次 mode 切换（如 Sidebar 点一下 → setMode('bus') →
// BusAdminPanel 此刻才挂载）。retain 让"晚挂载的消费者"在 subscribe 时立即补到值，
// 复刻原 store 字段"持续到被消费"的行为。消费者消费后 clear，避免重复触发。
//
// L1 纯度说明：topic 字符串是"跨 surface 导航意图"，其消费者（BusAdminPanel/Sidebar
// 等壳内 surface）目前仍驻留 interface（见 17b §7.4 —— 这些是壳/残留，非新耦合）。
// bus primitive 本身零 app 语义；本文件只是把散落的 topic 常量收敛到一处、加类型。
import { useEffect, useState, useCallback } from 'react';
import { publish, subscribe, peek, clearRetained } from './bus';

/** 已登记的跨-surface 深链 topic。payload 见下方 map。 */
export type DeepLinkTopic =
  | 'bus:expand-plugin'        // string   —— BusAdminPanel 展开某 plugin 行并滚动到
  | 'bus:filter-kind'          // string   —— BusAdminPanel solo 某 kind 过滤
  | 'sidebar:focus-plugin'     // string   —— Sidebar/AgentsPanel 滚动高亮某 agent（R4 消费者待补回）
  | 'sidebar:flash-kind'       // string   —— Sidebar BUS KINDS chip 闪烁（R4 消费者待补回）
  | 'chat:flash-bus-chip';     // string   —— ChatPanel TabStrip bus-chip 闪烁（R4 消费者待补回）

/** producer：发一条深链意图（retain 一次，晚挂载的消费者会补到）。 */
export function emitDeepLink(topic: DeepLinkTopic, payload: string): void {
  publish(topic, payload, { retain: true });
}

/** producer：清掉某 topic 的 retained 快照 + 通知在线消费者复位（原 `setPendingX(null)`）。
 *  用于"打开 B 面但不要带上一次残留的深链"（如 Dashboard goBus 只想开面板、不预过滤）。 */
export function clearDeepLink(topic: DeepLinkTopic): void {
  clearRetained(topic);
  publish(topic, null as unknown as string);
}

/** consumer hook：镜像原 `pendingX / setPendingX(null)` 对，但值由 L1 bus 承载。
 *  返回 `[value, clear]`：value 来自 retained 快照 + 后续 publish；clear() 清 retained + 本地。 */
export function useDeepLink(topic: DeepLinkTopic): [string | null, () => void] {
  const [val, setVal] = useState<string | null>(() => (peek(topic) as string | undefined) ?? null);
  useEffect(() => subscribe(topic, (p) => setVal((p as string | null) ?? null)), [topic]);
  const clear = useCallback(() => { clearRetained(topic); setVal(null); }, [topic]);
  return [val, clear];
}
