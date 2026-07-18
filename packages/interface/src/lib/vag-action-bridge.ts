/** vag-action-bridge —— editor 等 iframe 内 action 的 host 侧接入(P1-12)。
 *
 *  协议（只传可序列化数据，handler 留 iframe 本地，
 *  interface 刻意不 import editor,inline 校验照 healthBridge 先例):
 *
 *    iframe → host  VAG_ACTION_MANIFEST { type, actions: [{ id, title, description?,
 *                     inputSchema?, capability, surface?, timeoutMs? }] }
 *                   (整表替换语义:同一 iframe 重发即覆盖它之前登记的全部 action)
 *    host → iframe  VAG_ACTION_INVOKE { type, reqId, id, args }
 *    iframe → host  VAG_ACTION_RESULT { type, reqId, result }(result = UiActionResult 形)
 *
 *  host 侧把 iframe action 注册成 **proxy action**(run = postMessage 往返),从而
 *  ui_snapshot/ui_invoke/命令面板/右键 derive 全部自动覆盖 iframe 内功能——机制归
 *  本文件,内容归各 iframe。注:editor 子模块侧的发消息端待 editor 仓落地(本文件
 *  是 host 半边,协议以此为准)。
 */
import { registerAction, type UiActionResult, type UiCapability } from './action-registry';
import { isTrustedMessageOrigin } from './trustedOrigins';

const VALID_CAPS: ReadonlySet<string> = new Set([
  'read', 'write', 'delete', 'exec', 'network', 'credential', 'delegate', 'other',
]);
const INVOKE_TIMEOUT_MS = 8_000;
const MAX_ACTIONS_PER_FRAME = 200;

interface FrameState {
  source: Window;
  origin: string;
  unregister: Array<() => void>;
}

/** 每个 iframe(按 source window)一份登记状态;重发 manifest = 整表替换。 */
const frames = new Map<Window, FrameState>();
/** reqId → resolve(iframe 回 VAG_ACTION_RESULT 时解开)。 */
const pendingInvokes = new Map<string, (result: UiActionResult) => void>();

function sanitizeDecl(raw: unknown): {
  id: string; title: string; description?: string; inputSchema?: Record<string, unknown>;
  capability: UiCapability; surface?: 'ui' | 'server' | 'both'; timeoutMs?: number;
} | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  const capability = typeof o.capability === 'string' && VALID_CAPS.has(o.capability) ? (o.capability as UiCapability) : null;
  // capability 是权限声明,非法值整条丢弃(与 server 侧 manifest 消毒同口径,fail-closed)。
  if (!id || !title || !capability) return null;
  return {
    id, title, capability,
    ...(typeof o.description === 'string' ? { description: o.description } : {}),
    ...(o.inputSchema && typeof o.inputSchema === 'object' ? { inputSchema: o.inputSchema as Record<string, unknown> } : {}),
    ...(o.surface === 'ui' || o.surface === 'server' || o.surface === 'both' ? { surface: o.surface } : {}),
    ...(typeof o.timeoutMs === 'number' && o.timeoutMs > 0 ? { timeoutMs: Math.floor(o.timeoutMs) } : {}),
  };
}

function invokeInFrame(frame: FrameState, id: string, args: Record<string, unknown>, timeoutMs: number): Promise<UiActionResult> {
  const reqId = `vag-${Math.random().toString(36).slice(2)}`;
  return new Promise<UiActionResult>((resolve) => {
    const timer = setTimeout(() => {
      pendingInvokes.delete(reqId);
      resolve({ status: 'rejected', reason: `iframe did not answer within ${timeoutMs}ms` });
    }, timeoutMs);
    pendingInvokes.set(reqId, (result) => {
      clearTimeout(timer);
      pendingInvokes.delete(reqId);
      resolve(result);
    });
    try {
      frame.source.postMessage({ type: 'VAG_ACTION_INVOKE', reqId, id, args }, frame.origin);
    } catch (e) {
      clearTimeout(timer);
      pendingInvokes.delete(reqId);
      resolve({ status: 'rejected', reason: `postMessage failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  });
}

function handleManifest(source: Window, origin: string, rawActions: unknown): void {
  // 整表替换:先注销该 iframe 之前登记的全部 proxy action(幂等,HMR/重载安全)。
  const prev = frames.get(source);
  if (prev) for (const un of prev.unregister) un();
  const state: FrameState = { source, origin, unregister: [] };
  frames.set(source, state);
  if (!Array.isArray(rawActions)) return;

  for (const raw of rawActions.slice(0, MAX_ACTIONS_PER_FRAME)) {
    const decl = sanitizeDecl(raw);
    if (!decl) continue;
    const timeoutMs = Math.min(30_000, decl.timeoutMs ?? INVOKE_TIMEOUT_MS);
    state.unregister.push(
      registerAction({
        id: decl.id,
        title: decl.title,
        description: decl.description ?? `Invoke "${decl.title}" inside its panel (declared via VAG_ACTION_MANIFEST).`,
        schema: decl.inputSchema ?? { type: 'object', properties: {} },
        capability: decl.capability,
        surface: decl.surface ?? 'ui',
        timeoutMs,
        available: () => {
          try {
            return state.source.closed === false || state.source.closed === undefined
              ? true
              : 'origin iframe is gone (panel closed)';
          } catch {
            return 'origin iframe is gone (panel closed)';
          }
        },
        run: (args) => invokeInFrame(state, decl.id, args, timeoutMs),
      }),
    );
  }
}

let installed = false;

/** bootUiBridge 调用一次(幂等):挂 window message 监听,可信 origin 才处理。 */
export function installVagActionBridge(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('message', (e: MessageEvent) => {
    if (!isTrustedMessageOrigin(e.origin) || !e.data || typeof e.data !== 'object') return;
    const data = e.data as { type?: unknown; actions?: unknown; reqId?: unknown; result?: unknown };
    if (data.type === 'VAG_ACTION_MANIFEST' && e.source && typeof (e.source as Window).postMessage === 'function') {
      handleManifest(e.source as Window, e.origin, data.actions);
    } else if (data.type === 'VAG_ACTION_RESULT' && typeof data.reqId === 'string') {
      const resolve = pendingInvokes.get(data.reqId);
      if (!resolve) return;
      const r = data.result as UiActionResult | undefined;
      resolve(
        r && (r.status === 'completed' || r.status === 'accepted' || r.status === 'rejected')
          ? r
          : { status: 'completed', ...(data.result !== undefined ? { stateDigest: data.result } : {}) },
      );
    }
  });
}
