/** actionBridge —— UI 语义操作层的 **iframe 半边**(P1-12)。
 *
 *  编辑器面板经 `registerPanelAction(def)` 把自己的可调功能声明给 interface host
 *  (host 半边 interface/src/lib/vag-action-bridge.ts 把它注册成 ActionRegistry 的
 *  proxy action),从而 ui_snapshot / ui_invoke / 命令面板 / 右键 derive 自动覆盖
 *  iframe 内功能。协议 SSOT 见 protocol.ts 的 VAG_ACTION_* 三条 schema。
 *
 *  形态照 contextMenuService 的既定先例:**handler 留本进程(iframe)本地,wire 只传
 *  可序列化声明**;pop-out 窗口(无 interface parent)时静默 no-op(功能仍可被面板
 *  自己的 UI 触发,只是不出现在 host 注册表里)。
 *
 *  用法(面板侧):
 *    registerPanelAction({
 *      id: 'editor.preview_reload', title: '重载预览', capability: 'write',
 *      run: () => { doReload(); },
 *    });
 *  同 id 重复注册 = 替换(HMR 安全);注册后自动(debounce)重发整表 manifest。
 */
import {
  VagActionInvokeSchema,
  type VagActionManifestMessage,
} from '../protocol';

export interface PanelActionResult {
  status: 'completed' | 'accepted' | 'rejected';
  reason?: string;
  stateDigest?: unknown;
}

export interface PanelActionDef {
  id: string;
  title: string;
  description?: string;
  /** JSON Schema 纯对象(可序列化;过 wire 给 host / 模型)。缺省 = 无参数。 */
  inputSchema?: Record<string, unknown>;
  /** 权限声明(host 侧 trust-gate 按它分级;delete/credential 会弹用户确认卡)。 */
  capability: 'read' | 'write' | 'delete' | 'exec' | 'network' | 'credential' | 'delegate' | 'other';
  timeoutMs?: number;
  /** 执行体,留 iframe 本地,永不过 wire。返回 void 视为 completed。 */
  run: (args: Record<string, unknown>) => PanelActionResult | void | Promise<PanelActionResult | void>;
}

const registry = new Map<string, PanelActionDef>();
let manifestTimer: ReturnType<typeof setTimeout> | null = null;
let installed = false;

function embeddedParent(): Window | null {
  return typeof window !== 'undefined' && window.parent && window.parent !== window ? window.parent : null;
}

function postManifest(): void {
  const parent = embeddedParent();
  if (!parent) return; // pop-out / standalone → no-op
  const msg: VagActionManifestMessage = {
    type: 'VAG_ACTION_MANIFEST',
    actions: [...registry.values()].map((d) => ({
      id: d.id,
      title: d.title,
      ...(d.description ? { description: d.description } : {}),
      ...(d.inputSchema ? { inputSchema: d.inputSchema } : {}),
      capability: d.capability,
      surface: 'ui' as const, // iframe action 必然要 UI 在线
      ...(d.timeoutMs ? { timeoutMs: d.timeoutMs } : {}),
    })),
  };
  // 目标 origin '*':与 contextMenuService:57 同姿态 —— host 侧收信时做可信 origin 校验。
  parent.postMessage(msg, '*');
}

function scheduleManifest(): void {
  if (manifestTimer) clearTimeout(manifestTimer);
  manifestTimer = setTimeout(() => {
    manifestTimer = null;
    postManifest();
  }, 200);
}

async function handleInvoke(reqId: string, id: string, args: Record<string, unknown>): Promise<void> {
  const parent = embeddedParent();
  if (!parent) return;
  const def = registry.get(id);
  let result: PanelActionResult;
  if (!def) {
    result = { status: 'rejected', reason: `unknown panel action "${id}"` };
  } else {
    try {
      result = (await def.run(args)) ?? { status: 'completed' };
    } catch (e) {
      result = { status: 'rejected', reason: `panel action "${id}" threw: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  parent.postMessage({ type: 'VAG_ACTION_RESULT', reqId, result }, '*');
}

function install(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('message', (e: MessageEvent) => {
    // host(可信 parent)发来的 invoke;schema 校验挡畸形消息,来源即 parent 窗口。
    const parsed = VagActionInvokeSchema.safeParse(e.data);
    if (!parsed.success) return;
    void handleInvoke(parsed.data.reqId, parsed.data.id, (parsed.data.args ?? {}) as Record<string, unknown>);
  });
  // host 可能晚于面板加载(刷新/重连)→ 页面重新可见时重发 manifest 自愈。
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && registry.size > 0) scheduleManifest();
  });
}

/** 登记一个面板 action(同 id 替换,幂等)。返回注销函数;注册/注销都自动重发 manifest。 */
export function registerPanelAction(def: PanelActionDef): () => void {
  install();
  registry.set(def.id, def);
  scheduleManifest();
  return () => {
    if (registry.get(def.id) === def) {
      registry.delete(def.id);
      scheduleManifest();
    }
  };
}
