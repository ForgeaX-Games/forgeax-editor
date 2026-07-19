/** ui-trajectory —— 记录「页面上发生过哪些操作」的滚动轨迹(人 + AI 同一张表),
 *  作为 AI 可观察上下文出墙(ui_snapshot 的 `ui.trajectory` 片 + `trajectory.read` 工具)。
 *
 *  数据源 = action-registry 的**唯一**派发入口 `dispatchAction`,它每次派发都发
 *  `UI_ACTION_DISPATCH_EVENT`(人点按钮 / AI 经 ui_invoke,两条路都走它)。这里订阅它,
 *  落进一个定长环形缓冲。与 lib/ui-action-highlight.ts 互补:那边只闪「AI 那条」并丢弃
 *  人的操作;这里**两者都留**,因为 AI 要理解上下文就得看到用户刚才做了什么。
 *
 *  可序列化:entry 只含原始标量 / 浅裁剪后的 args,过得了 snapshotState 的 JSON 出墙。
 *  隐私:credential 级 action 的 args 整体打码(不把密钥类入参喂进 AI 上下文)。 */

import { getAction, UI_ACTION_DISPATCH_EVENT } from './action-registry';

export interface TrajectoryEntry {
  /** 单调自增序号(即使同毫秒也可稳定排序 / 去重)。 */
  seq: number;
  /** Date.now() 毫秒时间戳。 */
  ts: number;
  /** action id('domain.verb')。 */
  id: string;
  /** 人读标题(从注册表 derive;action 已注销则缺省)。 */
  title?: string;
  /** 谁触发的。 */
  source: 'human' | 'ai';
  /** 权限分级(从注册表 derive)。 */
  capability?: string;
  /** 浅裁剪后的入参(credential 级打码;缺省 = 无参)。 */
  args?: Record<string, unknown>;
}

// 环形缓冲容量 == `trajectory.read` 单次可拉上限(readTrajectory 用它收敛 limit)。
// 二者本就相等,故一个常量封两处:内存占用,以及 AI 一次拉取的**最坏上下文体积**
// (SNAPSHOT_TAIL 20 条随每次 ui_snapshot 出墙不受此限;这里管的是按需 read 的天花板)。
// 定 200:近 200 条操作足够 AI 理解上下文,同时把最坏一次拉取从 ~500 条压到 ~200 条。
const MAX = 200;
const buffer: TrajectoryEntry[] = [];
let seq = 0;
let stop: (() => void) | null = null;

/** 环形缓冲上限 == 单次 read 上限(供工具的 limit 收敛 + tool 描述出墙)。 */
export const TRAJECTORY_MAX = MAX;

/** 浅裁剪 args:长字符串截断、嵌套结构降级为占位、credential 级整体打码。 */
function redactArgs(
  args: Record<string, unknown> | undefined,
  capability?: string,
): Record<string, unknown> | undefined {
  if (!args || Object.keys(args).length === 0) return undefined;
  if (capability === 'credential') return { redacted: true };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') out[k] = v.length > 120 ? `${v.slice(0, 120)}…` : v;
    else if (v === null || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else out[k] = Array.isArray(v) ? `[array:${v.length}]` : `[${typeof v}]`;
  }
  return out;
}

/** 记录一条轨迹。跳过 `trajectory.*` 自省读写,避免 AI 拉轨迹时污染轨迹本身。 */
export function recordTrajectory(detail: {
  id: string;
  source: 'human' | 'ai';
  args?: Record<string, unknown>;
}): void {
  if (!detail || typeof detail.id !== 'string') return;
  if (detail.id.startsWith('trajectory.')) return;
  const def = getAction(detail.id);
  const entry: TrajectoryEntry = {
    seq: ++seq,
    ts: Date.now(),
    id: detail.id,
    source: detail.source === 'ai' ? 'ai' : 'human',
  };
  if (def?.title) entry.title = def.title;
  if (def?.capability) entry.capability = def.capability;
  const args = redactArgs(detail.args, def?.capability);
  if (args) entry.args = args;
  buffer.push(entry);
  if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
}

/** 读取轨迹尾部(oldest→newest)。source 过滤按「谁触发」。 */
export function readTrajectory(opts: { limit?: number; source?: 'human' | 'ai' } = {}): {
  total: number;
  count: number;
  entries: TrajectoryEntry[];
} {
  const src = opts.source === 'human' || opts.source === 'ai' ? opts.source : undefined;
  const filtered = src ? buffer.filter((e) => e.source === src) : buffer;
  const limit = Math.min(opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : 50, MAX);
  const entries = filtered.slice(-limit);
  return { total: filtered.length, count: entries.length, entries };
}

/** 清空缓冲,返回清掉的条数。 */
export function clearTrajectory(): number {
  const n = buffer.length;
  buffer.length = 0;
  return n;
}

/** 订阅派发事件开始记录(幂等:重复调返回同一退订)。返回退订函数。 */
export function startTrajectoryRecording(): () => void {
  if (typeof window === 'undefined') return () => {};
  if (stop) return stop;
  const onDispatch = (e: Event) => {
    const d = (e as CustomEvent).detail as
      | { id: string; source: 'human' | 'ai'; args?: Record<string, unknown> }
      | undefined;
    if (d) recordTrajectory(d);
  };
  window.addEventListener(UI_ACTION_DISPATCH_EVENT, onDispatch);
  stop = () => {
    window.removeEventListener(UI_ACTION_DISPATCH_EVENT, onDispatch);
    stop = null;
  };
  return stop;
}
