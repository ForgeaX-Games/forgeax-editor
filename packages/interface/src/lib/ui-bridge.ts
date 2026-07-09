/** ui-bridge —— UI 语义操作层的 interface 侧运输层:lease + manifest push + ui_* 应答。
 *
 *  对端(编排层 forgeax-cli):
 *    - POST /:sid/ui-lease       获焦 acquire / 心跳续期(displace 语义,「最后获焦 tab」持有)
 *    - POST /:sid/ui-manifest    registry 变更时 push 可序列化 manifest(**必须持 lease**——
 *                                manifest 是 trust-gate 的权限输入,声明与执行方必须同源)
 *    - perception:query(WS)     kind = ui_snapshot / ui_invoke → 本模块应答
 *    - POST /:sid/perception-reply  带 leaseId 回灌(server 校验;非持有者的回灌被拒)
 *
 *  多标签规则(评审 2.7,P0 定死):最后获焦的 tab 持 lease,WS 心跳续期;收到 ui_* 查询
 *  且本 tab 可见而无 lease 时机会式 acquire(单 tab 断续场景自愈;两 tab 同可见时后
 *  acquire 者胜,server 只认现任 leaseId,不会双应答)。
 */
import { onSessionEvent, type SessionEvent } from './forgeax-bridge';
import {
  buildManifest,
  dispatchAction,
  onRegistryChange,
  snapshotActions,
  snapshotState,
} from './action-registry';
import { registerBuiltinActions } from './builtin-actions';
import { startActionDomDiscovery } from './action-dom-discovery';
import { installUiActionHighlight } from './ui-action-highlight';
import { installVagActionBridge } from './vag-action-bridge';
import { buildA11ySummary } from './a11y-summary';
import { isTrustedMessageOrigin } from './trustedOrigins';
import { useAppStore } from '../store';

const clientId = (() => {
  try {
    return crypto.randomUUID();
  } catch {
    return `tab-${Math.random().toString(36).slice(2)}`;
  }
})();

interface LeaseRecord {
  leaseId: string;
  expiresAt: number;
}

const leases = new Map<string, LeaseRecord>();
/** 见过的 sid(store activeSid + 收到过 ui_* 查询的)——心跳续期的范围。 */
const knownSids = new Set<string>();

function holdingLease(sid: string): string | null {
  const l = leases.get(sid);
  return l && l.expiresAt > Date.now() ? l.leaseId : null;
}

async function acquireLease(sid: string, opts: { skipPush?: boolean } = {}): Promise<string | null> {
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/ui-lease`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId }),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; leaseId?: string; ttlMs?: number };
    if (!j.ok || typeof j.leaseId !== 'string') return null;
    leases.set(sid, { leaseId: j.leaseId, expiresAt: Date.now() + (j.ttlMs ?? 30_000) });
    knownSids.add(sid);
    // 每次 acquire 成功都重推 manifest(幂等整表替换,payload 很小)。顺序约束:trust-gate
    // 的查表在 invoke 往返**之前**发生,manifest 必须先于第一次 ui_invoke 到位,否则
    // fail-closed ask;「只在首次推」曾在会话切换场景留下一次竞态缺口(e2e Test D),
    // 无条件重推把这类缺口整类消掉。skipPush 防 pushManifest→acquireLease 递归。
    if (!opts.skipPush) void pushManifest(sid);
    return j.leaseId;
  } catch {
    return null;
  }
}

async function pushManifest(sid: string): Promise<void> {
  const leaseId = holdingLease(sid) ?? (await acquireLease(sid, { skipPush: true }));
  if (!leaseId) return; // 拿不到 lease(别的 tab 持有)→ 不推,由持有者推
  try {
    await fetch(`/api/sessions/${encodeURIComponent(sid)}/ui-manifest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leaseId, actions: buildManifest() }),
    });
  } catch {
    /* fail-soft:下次 registry 变更 / lease 续期再推 */
  }
}

// ─── ui_* 查询应答 ───────────────────────────────────────────────────────────

interface UiQueryPayload {
  reqId?: string;
  kind?: string;
  query?: unknown;
}

async function answerUiQuery(evt: SessionEvent): Promise<void> {
  if (evt.event.type !== 'perception:query') return;
  const p = evt.event.payload as UiQueryPayload;
  const kind = p.kind;
  if (kind !== 'ui_snapshot' && kind !== 'ui_invoke') return; // world/frame 归 preview surface
  if (typeof p.reqId !== 'string') return;
  const sid = evt.sid;
  knownSids.add(sid);

  // lease 检查:非持有者不应答。本 tab 可见而无 lease → 机会式 acquire(displace)。
  let leaseId = holdingLease(sid);
  if (!leaseId && typeof document !== 'undefined' && document.visibilityState === 'visible') {
    leaseId = await acquireLease(sid);
  }
  if (!leaseId) return;

  let snapshot: unknown;
  if (kind === 'ui_snapshot') {
    const q = (p.query ?? {}) as { detail?: unknown; ids?: unknown };
    const detail = typeof q.detail === 'string' ? q.detail : undefined;
    snapshot = {
      actions: snapshotActions(
        detail,
        Array.isArray(q.ids) ? q.ids.filter((x): x is string => typeof x === 'string') : undefined,
      ),
      state: snapshotState(),
      // P1-13 a11y 兜底:未注册区域的只读定向摘要(detail:'a11y' 按需拉,默认不带)。
      ...(detail === 'a11y' ? { a11y: buildA11ySummary() } : {}),
    };
  } else {
    const q = (p.query ?? {}) as { actionId?: unknown; args?: unknown };
    if (typeof q.actionId !== 'string' || !q.actionId) {
      snapshot = { status: 'rejected', reason: 'ui_invoke requires actionId (string)' };
    } else {
      snapshot = await dispatchAction(
        q.actionId,
        q.args && typeof q.args === 'object' ? (q.args as Record<string, unknown>) : {},
        { source: 'ai' },
      );
    }
  }

  try {
    await fetch(`/api/sessions/${encodeURIComponent(sid)}/perception-reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reqId: p.reqId, snapshot, leaseId }),
    });
  } catch {
    /* fail-soft:server 侧超时兜底 */
  }
}

// ─── 全局快捷键的 iframe→host 接收器(todo 004)──────────────────────────────
// 焦点在 iframe 内时,命令面板(⌘K)/ useGlobalShortcuts 的顶层监听拿不到按键。
// 各 iframe 内装 `installShortcutForwarder`(权威在 @forgeax/host-sdk,消费方 vendor)
// 把白名单键 postMessage 上来;此处校验 origin 后在顶层重放 → 现有监听自动统一处理。
// 常量与 host-sdk `shortcut-forwarder.ts` 保持一致(interface 不 dep host-sdk,故内联)。
const FORGEAX_FORWARD_KEY = 'FORGEAX_FORWARD_KEY';

let shortcutReceiverInstalled = false;

function installShortcutReceiver(): void {
  if (shortcutReceiverInstalled || typeof window === 'undefined') return;
  shortcutReceiverInstalled = true;
  window.addEventListener('message', (e: MessageEvent) => {
    if (!isTrustedMessageOrigin(e.origin) || !e.data || typeof e.data !== 'object') return;
    const d = e.data as {
      type?: unknown; key?: unknown; code?: unknown; keyCode?: unknown;
      metaKey?: unknown; ctrlKey?: unknown; shiftKey?: unknown; altKey?: unknown;
    };
    if (d.type !== FORGEAX_FORWARD_KEY || typeof d.key !== 'string') return;
    // 在顶层重放 keydown → CommandPalette(window keydown)+ useGlobalShortcuts(capture)
    // 都在 window 上监听,dispatch 到 window 即 AT_TARGET 触发两者。合成事件 target=window,
    // isTypingTarget 返回 false,故 Esc / Ctrl+/ 等 allowInInput 键也照常。
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: d.key,
      code: typeof d.code === 'string' ? d.code : '',
      keyCode: typeof d.keyCode === 'number' ? d.keyCode : 0,
      metaKey: !!d.metaKey,
      ctrlKey: !!d.ctrlKey,
      shiftKey: !!d.shiftKey,
      altKey: !!d.altKey,
      bubbles: true,
      cancelable: true,
    }));
  });
}

// ─── boot ───────────────────────────────────────────────────────────────────

let booted = false;
let repushTimer: ReturnType<typeof setTimeout> | null = null;

/** main.tsx 调用一次(幂等):登记内置 action + DOM 发现 + lease 生命周期 + 查询应答。 */
export function bootUiBridge(): void {
  if (booted || typeof window === 'undefined') return;
  booted = true;

  registerBuiltinActions();
  startActionDomDiscovery();
  installUiActionHighlight(); // P1-11:AI 派发时闪高亮 / 浮标
  installVagActionBridge(); // P1-12:iframe 内 action 经 VAG_ACTION_* 接入注册表
  installShortcutReceiver(); // todo 004:iframe 内全局快捷键(⌘K 等)转发上来,顶层重放

  // ui_* 查询应答(onSessionEvent 按 key 幂等,HMR 安全;world/frame 由 perception-stream 继续中转)。
  onSessionEvent('ui-bridge', (evt) => void answerUiQuery(evt));

  // registry 变更 → debounce 重推 manifest(只推本 tab 持 lease 的 sid)。
  onRegistryChange(() => {
    if (repushTimer) clearTimeout(repushTimer);
    repushTimer = setTimeout(() => {
      repushTimer = null;
      for (const sid of knownSids) if (holdingLease(sid)) void pushManifest(sid);
    }, 300);
  });

  // 获焦 / 可见 → acquire(displace:「最后获焦 tab」成为权威 surface)。
  const onFocus = (): void => {
    const sid = useAppStore.getState().activeSid;
    if (sid) void acquireLease(sid);
  };
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') onFocus();
  });

  // activeSid 变化 → 对新会话建 lease + 推 manifest。
  let lastSid: string | null = null;
  useAppStore.subscribe((state) => {
    const sid = state.activeSid ?? null;
    if (sid && sid !== lastSid) {
      lastSid = sid;
      void acquireLease(sid);
    }
  });
  onFocus(); // boot 时若已可见,立即建 lease

  // 心跳续期(TTL 30s → 每 10s;仅本 tab 可见时续,失焦让位给获焦 tab)。
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    for (const sid of knownSids) if (holdingLease(sid)) void acquireLease(sid);
  }, 10_000);
}
