/** action-registry —— UI 语义操作层(产品 AI 化 P0)的单一真值源:
 *  「本产品当前暴露哪些可被人 / AI 调用的功能」。
 *
 *  一张注册表服务三个消费者(压缩公理:消掉「AI 能做的和人能做的是不是同一套?」):
 *    1. 按钮 onClick —— 组件经 `dispatchAction(id, args)` 派发(与 AI 同一条路);
 *    2. 命令面板(P2,cmdk 激活时数据源即本表);
 *    3. AI 工具调用 —— `ui_snapshot` 读清单 / `ui_invoke` 派发,经 lib/ui-bridge.ts
 *       的 perception 往返接到编排层(forgeax-cli)。
 *
 *  契约形态(评审 2.1):`schema` 的 SSOT 是 **JSON Schema 纯对象**(AI 侧 ToolSpec 与
 *  postMessage 结构化克隆都只吃 JSON;函数永不过 wire)。`available` / `run` 只活在
 *  本模块,manifest(`buildManifest`)只导出可序列化子集。
 *
 *  headless 边界(方案 §5):`surface:'both'` 的 action,UI `run()` 必须调 server 的
 *  同一 HTTP API(server 是行为 SSOT),UI 侧只许加视觉反馈——不许长出独立业务逻辑。
 */

/** 与编排层 trust-gate 的 Capability 8 类对齐(权限分级的声明值,manifest 里出墙)。 */
export type UiCapability =
  | 'read'
  | 'write'
  | 'delete'
  | 'exec'
  | 'network'
  | 'credential'
  | 'delegate'
  | 'other';

/** 派发结果(评审 2.2 act→observe 合并):
 *  - completed:已完成,`stateDigest` 携带可观察的状态变化(多数场景免掉后续 snapshot);
 *  - accepted:已受理、异步在跑(慢 action 快速返回,勿等勿重试;P0 期完成态靠下次 snapshot 观察);
 *  - rejected:未执行,`reason` 给人话原因(未注册 / 不可用 / 参数校验失败 / run 抛错)。 */
export interface UiActionResult {
  status: 'completed' | 'accepted' | 'rejected';
  reason?: string;
  stateDigest?: unknown;
}

/** JSON Schema 纯对象(不引 zod 类型;zod 只是书写便利,登记时即转换落表)。 */
export type JsonSchemaObject = Record<string, unknown>;

export interface UiActionDef {
  /** 稳定 id,'domain.verb' 形("game.switch" / "panel.toggle_sidebar")。 */
  id: string;
  /** 人读标题(菜单 / 命令面板 / 权限卡展示)。 */
  title: string;
  /** AI 读说明(manifest 出墙;写清做什么 + 何时用)。 */
  description?: string;
  /** 参数契约(JSON Schema 纯对象)。缺省 = 无参数。 */
  schema?: JsonSchemaObject;
  /** 权限分级声明 —— 编排层 trust-gate 按此弹卡/直放(delete/credential 会请求用户确认)。 */
  capability: UiCapability;
  /** headless 可用性:'ui'(纯视图,须 UI 在线)/ 'server'/'both'(状态型,server 是 SSOT)。 */
  surface?: 'ui' | 'server' | 'both';
  /** 预期执行时长(ms)——编排层往返超时据此放宽;慢 action 的正道是快速回 accepted。 */
  timeoutMs?: number;
  /** 当前是否可调。返回 string = 不可用 + 人话原因(AI 可读可解释);缺省恒可用。 */
  available?: () => true | string;
  /** P1-9 一等工具化:标 true → 编排层从 manifest 派生独立 ToolSpec(ui_act_*)下发
   *  模型,免一次 snapshot 发现往返。只给高频 action 打标(编排层有数量上限)。 */
  firstClass?: boolean;
  /** 「人」界面(命令面板)用的**动态候选值**提供器,按参数名给一列合法取值 —— 让
   *  自由文本参数(如 game.switch 的 slug)变成下拉,避免瞎填后触发 server 404。
   *  仅活在客户端(同 run/available,不进 manifest);AI 侧靠 ui_snapshot / 状态片发现,
   *  不依赖此。静态 `schema.enum` 优先于此(两者都无则退回文本框)。 */
  choices?: Record<string, () => string[] | Promise<string[]>>;
  /** 执行体。返回 void 视为 completed;抛错翻成 rejected(fail-soft,不炸往返)。 */
  run: (args: Record<string, unknown>) => UiActionResult | void | Promise<UiActionResult | void>;
}

/** snapshot 状态摘要的一片(评审 2.5:注册式 derive,禁手写台账)。selector 从 store
 *  等真值源读,值必须可序列化(过 JSON.stringify)。 */
export type StateSliceSelector = () => unknown;

// ─── 注册表本体(模块级 Map,页级单例)────────────────────────────────────────

const actions = new Map<string, UiActionDef>();
const stateSlices = new Map<string, StateSliceSelector>();
const changeListeners = new Set<() => void>();

function notifyChange(): void {
  for (const cb of changeListeners) {
    try {
      cb();
    } catch {
      /* listener 异常不传染 */
    }
  }
}

/** 注册一个 action(同 id 重复注册 = 替换,幂等;HMR 安全)。返回注销函数。 */
export function registerAction(def: UiActionDef): () => void {
  actions.set(def.id, def);
  notifyChange();
  return () => {
    if (actions.get(def.id) === def) {
      actions.delete(def.id);
      notifyChange();
    }
  };
}

/** 注册一片状态摘要(同 id 替换,幂等)。返回注销函数。 */
export function registerStateSlice(id: string, selector: StateSliceSelector): () => void {
  stateSlices.set(id, selector);
  notifyChange();
  return () => {
    if (stateSlices.get(id) === selector) {
      stateSlices.delete(id);
      notifyChange();
    }
  };
}

/** 注册表(action 或 state slice)变更订阅 —— ui-bridge 据此 debounce 重推 manifest。 */
export function onRegistryChange(cb: () => void): () => void {
  changeListeners.add(cb);
  return () => changeListeners.delete(cb);
}

export function getAction(id: string): UiActionDef | undefined {
  return actions.get(id);
}

// ─── 派发单入口(评审 2.4:data-* 只做发现,执行永远走这里)──────────────────

/** AI 派发时打的来源标记;window 事件供 ghost 高亮层(P1)与 telemetry / 轨迹追踪衔接。
 *  detail 形:`{ id, source, args }` —— args 让轨迹追踪(lib/ui-trajectory)记得下「做了啥」,
 *  ghost 高亮只用 id/source(向后兼容,多带的字段无害)。 */
export const UI_ACTION_DISPATCH_EVENT = 'forgeax:ui-action-dispatch';

/** 极简 JSON Schema 参数校验(P0:required + 顶层 properties 的原始类型)。
 *  不引 ajv——契约漂移由编排层契约测试兜,这里挡住明显错参即可(Fail Fast)。 */
function validateArgs(schema: JsonSchemaObject | undefined, args: Record<string, unknown>): true | string {
  if (!schema) return true;
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : [];
  for (const k of required) {
    if (typeof k === 'string' && !(k in args)) return `missing required arg "${k}"`;
  }
  const props = schema.properties && typeof schema.properties === 'object'
    ? (schema.properties as Record<string, { type?: unknown; enum?: unknown[] }>)
    : {};
  for (const [k, v] of Object.entries(args)) {
    const p = props[k];
    if (!p) continue; // 未声明的多余参数放过(向前兼容),由 run 自行忽略
    const t = p.type;
    if (typeof t === 'string') {
      const actual = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
      const okType =
        (t === 'string' && actual === 'string') ||
        (t === 'number' && actual === 'number') ||
        (t === 'integer' && actual === 'number' && Number.isInteger(v)) ||
        (t === 'boolean' && actual === 'boolean') ||
        (t === 'object' && actual === 'object') ||
        (t === 'array' && actual === 'array');
      if (!okType) return `arg "${k}" should be ${t}, got ${actual}`;
    }
    if (Array.isArray(p.enum) && !p.enum.includes(v)) {
      return `arg "${k}" must be one of ${JSON.stringify(p.enum)}`;
    }
  }
  return true;
}

/** 派发一个 action —— 按钮与 AI 共用的**唯一**执行入口(未注册的 id 拒绝,fail-closed)。 */
export async function dispatchAction(
  id: string,
  args: Record<string, unknown> = {},
  opts: { source?: 'human' | 'ai' } = {},
): Promise<UiActionResult> {
  const src = opts.source ?? 'human';
  // [fx-action-trace] 定位「点了/调了没反应」的最小充分打点:
  //   ① entry —— 派发是否发生 + args/source(缺此行 = 根本没触发 dispatch)。
  //   ② terminal —— 唯一终态行:completed/accepted 带 stateDigest(判「到底改了啥」),
  //      rejected 带 reason(未注册/不可用/参数错/run 抛错 已统一收敛进 reason)。
  // 两行即可定位:有 entry 无 terminal = 卡在 run();rejected+reason = 为何被拒;
  // completed 但 stateDigest 没变 = action 效果与 UI 脱节。故只留这两点(+抛错补栈)。
  console.info(`%c[fx-action]%c ▶ ${id} (${src})`, 'color:#818cf8;font-weight:bold', 'color:inherit', { args });
  const done = (r: UiActionResult): UiActionResult => {
    if (r.status === 'rejected') {
      console.warn(`[fx-action] ✗ ${id} rejected: ${r.reason ?? ''}`);
    } else {
      console.info(
        `%c[fx-action]%c ✔ ${id} → ${r.status}`,
        'color:#34d399;font-weight:bold',
        'color:inherit',
        r.stateDigest !== undefined ? { stateDigest: r.stateDigest } : {},
      );
    }
    return r;
  };

  const def = actions.get(id);
  if (!def) return done({ status: 'rejected', reason: `unknown action "${id}" (not in the registry)` });

  const avail = def.available ? safeAvailable(def) : true;
  if (avail !== true) return done({ status: 'rejected', reason: avail });

  const valid = validateArgs(def.schema, args);
  if (valid !== true) return done({ status: 'rejected', reason: valid });

  try {
    window.dispatchEvent(new CustomEvent(UI_ACTION_DISPATCH_EVENT, { detail: { id, source: src, args } }));
  } catch {
    /* SSR / no window — ignore */
  }

  try {
    const out = await def.run(args);
    return done(out ?? { status: 'completed' });
  } catch (e) {
    console.error(`[fx-action] ✗ ${id} threw`, e); // 抛错补一行栈(定位真异常)
    return done({ status: 'rejected', reason: `action "${id}" threw: ${e instanceof Error ? e.message : String(e)}` });
  }
}

function safeAvailable(def: UiActionDef): true | string {
  try {
    return def.available!();
  } catch (e) {
    return `availability check threw: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ─── snapshot / manifest 视图(全部 derive 自注册表,可序列化)─────────────────

export interface UiActionSummary {
  id: string;
  title: string;
  available: boolean;
  reason?: string;
  /** detail:'schema' 时补上。 */
  description?: string;
  inputSchema?: JsonSchemaObject;
}

/** ui_snapshot 的 action 视图。分层(评审 2.7):默认轻量清单;detail:'schema' + ids
 *  按需展开 schema 与详细说明(长尾几百 action 也不炸 token)。 */
export function snapshotActions(detail?: string, ids?: string[]): UiActionSummary[] {
  const expand = detail === 'schema' ? new Set(ids ?? []) : null;
  const out: UiActionSummary[] = [];
  for (const def of actions.values()) {
    const avail = def.available ? safeAvailable(def) : true;
    const row: UiActionSummary = {
      id: def.id,
      title: def.title,
      available: avail === true,
      ...(avail === true ? {} : { reason: avail }),
    };
    if (expand?.has(def.id)) {
      if (def.description) row.description = def.description;
      row.inputSchema = def.schema ?? { type: 'object', properties: {} };
    }
    out.push(row);
  }
  return out;
}

/** ui_snapshot 的状态摘要:逐片 derive,单片异常不传染(fail-soft)。 */
export function snapshotState(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, selector] of stateSlices) {
    try {
      out[id] = selector();
    } catch (e) {
      out[id] = { error: `state slice threw: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  return out;
}

/** manifest(POST /:sid/ui-manifest 的 payload)—— 只含可序列化声明,函数永不出墙。
 *  它是编排层 trust-gate 的权限输入:capability 必须如实声明。 */
export function buildManifest(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const def of actions.values()) {
    out.push({
      id: def.id,
      title: def.title,
      ...(def.description ? { description: def.description } : {}),
      inputSchema: def.schema ?? { type: 'object', properties: {} },
      capability: def.capability,
      ...(def.surface ? { surface: def.surface } : {}),
      ...(def.timeoutMs ? { timeoutMs: def.timeoutMs } : {}),
      ...(def.firstClass ? { firstClass: true } : {}),
    });
  }
  return out;
}

/** 测试用:清空注册表(生产代码不要调)。 */
export function __resetRegistryForTest(): void {
  actions.clear();
  stateSlices.clear();
  changeListeners.clear();
}
