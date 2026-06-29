// P9.3 — useSurface() hook + thin client around /api/bus/ui/* (server router
// lives at packages/server/src/api/ui-surfaces.ts).
//
// Spec: forgeax-dev-diary/2026-05-16/DUAL-MODALITY-UI.md §四 (4 层物理实现)
//
// 双模态 (dual-modality) 收敛点的 React 端实现:
//   1. mount   useSurface() effect 启动时 POST /surfaces 注册 schema + 初始 snapshot
//   2. update  调用方每次 state 变化调 setSnapshot() 并 PUT 服务端镜像
//   3. dispatch DOM event handler 调 dispatch('act', args) 直走本地 actions[act].run
//   4. ai-path  AI POST /surfaces/:id/action 入队; hook 轮询 /pending 拉走 +
//               同样调 actions[act].run + POST /ack 上报结果
//   5. unmount  cleanup -> DELETE /surfaces/:id
//
// 注意: 服务端 registry 是 in-mem 单进程; vite dev 重启不掉服务端 -- 我们靠
// register 时 "re-mount 同 id" 语义 (UISurfaceRegistry.register 检测旧 record,
// pending 不丢, 走 ui.surface.mounted remount:true) 保证刷新无副作用.

import { useEffect, useRef, useState, useCallback } from "react";

const POLL_INTERVAL_MS = 1000;

/** 服务端 ui-surfaces.ts 的 JsonSchema 同构, 客户端不强约束. */
export type JsonSchema = Record<string, unknown>;

export type UIActionSource = "ai" | "user" | "plugin";

export interface UISurfaceActionDef<A = unknown> {
  /** 唯一动作 id (跨 surface 内唯一). */
  id: string;
  argsSchema?: JsonSchema;
  exposedToAI?: boolean;
  requireConfirm?: boolean;
  /** Local handler. 玩家 / AI 路径在这里收敛.
   *  返回值会作为 ack.result 回服务端. throw -> ack.ok=false + error. */
  run: (args: A, ctx: ActionContext) => unknown | Promise<unknown>;
}

export interface ActionContext {
  /** 来源 'ai' / 'user' / 'plugin' -- handler 可据此决定是否弹确认. */
  source: UIActionSource;
  /** AI 路径独有: enqueueAction 给的 token. user 路径为 null. */
  token: string | null;
}

export interface UseSurfaceOptions<S, AMap extends Record<string, UISurfaceActionDef>> {
  id: string;
  layer?: "host" | "plugin" | "iframe";
  schema: JsonSchema;
  initialSnapshot: S;
  actions: AMap;
  /** false -> 整个 surface 不报给 AI (e.g. dev-only debug surface). 默认 true. */
  exposedToAI?: boolean;
  /** AI pending action 轮询间隔. <=0 关闭轮询. 默认 1000ms. */
  pollIntervalMs?: number;
}

export interface SurfaceHandle<S, AMap extends Record<string, UISurfaceActionDef>> {
  /** 当前 snapshot (React state, 触发 re-render). */
  snapshot: S;
  /** 主写入入口 -- 调用方更新 state 时调; 同时 PUT 给服务端. */
  setSnapshot: (next: S | ((prev: S) => S)) => void;
  /** 玩家 / 本地路径调一个 action. 也是 AI 路径轮询拿到 pending 后内部调的同一函数. */
  dispatch: <K extends keyof AMap>(
    action: K,
    args: Parameters<AMap[K]["run"]>[0],
  ) => Promise<unknown>;
  /** 服务端是否已确认 register OK (failed register 不阻塞 UI, 但 AI 路径会熄火). */
  mounted: boolean;
  /** 最近一次 PUT/POST 错误 (用于 dev banner). */
  lastError: string | null;
}

interface PendingActionWire {
  seq: number;
  surfaceId: string;
  action: string;
  args: unknown;
  source: UIActionSource;
  token: string;
  ts: number;
}

/**
 * useSurface -- 把一个 React 组件挂成 UISurface.
 *
 * 重要不变量 (DUAL-MODALITY §2.1):
 *   - DOM event handler 内部必须走 dispatch() 而非 inline setState; 这是把 AI 路径
 *     提升成一等公民的代价. setSnapshot 只用于"非动作驱动的状态同步"
 *     (e.g. 外部 store mirror).
 *   - 每次 setSnapshot 自动 PUT 服务端镜像 (server 是 snapshot 的 source of truth
 *     for AI; React state 是 source of truth for DOM render).
 *
 * 错误处理: register 失败不抛 -- 客户端仍可玩本地, 只是 AI 看不到这个 surface.
 * lastError 暴露原因, dev banner 可挂.
 */
export function useSurface<S, AMap extends Record<string, UISurfaceActionDef>>(
  opts: UseSurfaceOptions<S, AMap>,
): SurfaceHandle<S, AMap> {
  const { id, layer = "host", schema, initialSnapshot, actions, exposedToAI, pollIntervalMs } = opts;

  const [snapshot, _setSnapshot] = useState<S>(initialSnapshot);
  const [mounted, setMounted] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const snapshotRef = useRef<S>(initialSnapshot);
  const actionsRef = useRef<AMap>(actions);

  // actionsRef 跟随 actions prop (closures 经常引用最新 state) -- 关键: 不要把
  // actions 进依赖, 否则每次父组件 re-render 都会触发卸载 -> 重新 register, 闪烁.
  actionsRef.current = actions;

  // setSnapshot wrapper -- 1) React state 2) snapshot ref 3) PUT 服务端
  const setSnapshot = useCallback((next: S | ((prev: S) => S)) => {
    _setSnapshot((prev) => {
      const v = typeof next === "function" ? (next as (p: S) => S)(prev) : next;
      snapshotRef.current = v;
      // Fire-and-forget; PUT 失败仅写 lastError, 不回滚 React state.
      void fetch(`/api/bus/ui/surfaces/${encodeURIComponent(id)}/snapshot`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ snapshot: v }),
      })
        .then((r) => {
          if (!r.ok) setLastError(`PUT snapshot HTTP ${r.status}`);
          else setLastError(null);
        })
        .catch((e) => setLastError(`PUT snapshot: ${(e as Error).message}`));
      return v;
    });
  }, [id]);

  // dispatch -- DOM 路径 + AI 路径在这里收敛.
  const dispatch = useCallback(
    async <K extends keyof AMap>(action: K, args: Parameters<AMap[K]["run"]>[0]) => {
      const def = actionsRef.current[action];
      if (!def) {
        throw new Error(`[useSurface ${id}] unknown action: ${String(action)}`);
      }
      return await def.run(args, { source: "user", token: null });
    },
    [id],
  );

  // register / unregister effect -- 仅依赖 id + layer + schema + exposedToAI.
  // actions 通过 actionsRef 兜底, 不进依赖.
  useEffect(() => {
    let cancelled = false;
    const body = {
      id,
      layer,
      schema,
      snapshot: snapshotRef.current,
      exposedToAI: exposedToAI !== false,
      actions: Object.values(actionsRef.current).map((a) => ({
        id: a.id,
        argsSchema: a.argsSchema,
        exposedToAI: a.exposedToAI,
        requireConfirm: a.requireConfirm,
      })),
    };
    fetch("/api/bus/ui/surfaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((r) => {
        if (cancelled) return;
        if (!r.ok) {
          setLastError(`register HTTP ${r.status}`);
          setMounted(false);
        } else {
          setLastError(null);
          setMounted(true);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setLastError(`register: ${(e as Error).message}`);
          setMounted(false);
        }
      });
    return () => {
      cancelled = true;
      // best-effort DELETE -- 失败不影响 React 卸载.
      void fetch(`/api/bus/ui/surfaces/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, layer, exposedToAI]);

  // pending-action polling -- AI 路径的客户端 puller.
  useEffect(() => {
    const interval = pollIntervalMs ?? POLL_INTERVAL_MS;
    if (interval <= 0) return;
    if (!mounted) return;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // 404 backoff -- StrictMode 双 mount / 启动期 race 期间 register POST
    // 还没落到 server, polling 这边就先看到 404. 默认 1s 间隔会瞬间在 console
    // 喷一大坨. 收到 404 时退避到 30s, 给 register 留下窗口; 任何 200 立刻
    // 回到正常 interval.
    const NOT_FOUND_BACKOFF_MS = 30_000;
    const tick = async () => {
      if (stopped) return;
      let nextDelay = interval;
      try {
        const r = await fetch(`/api/bus/ui/surfaces/${encodeURIComponent(id)}/pending`);
        if (!stopped && r.ok) {
          const body = (await r.json()) as { items: PendingActionWire[] };
          for (const item of body.items) {
            const def = actionsRef.current[item.action];
            if (!def) {
              // ack as error so server side ledger logs it -- 客户端没这个 action 了
              await ack(id, item.token, false, undefined, `client-side unknown action: ${item.action}`);
              continue;
            }
            try {
              const result = await def.run(item.args as never, { source: item.source, token: item.token });
              await ack(id, item.token, true, result, undefined);
            } catch (e) {
              await ack(id, item.token, false, undefined, (e as Error).message);
            }
          }
        } else if (!stopped && r.status === 404) {
          nextDelay = NOT_FOUND_BACKOFF_MS;
        }
      } catch {
        // 网络抖动: 静默重试; lastError 由 register / snapshot 路径报.
      } finally {
        if (!stopped) timer = setTimeout(tick, nextDelay);
      }
    };
    timer = setTimeout(tick, interval);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [id, mounted, pollIntervalMs]);

  return { snapshot, setSnapshot, dispatch, mounted, lastError };
}

async function ack(
  id: string,
  token: string,
  ok: boolean,
  result: unknown,
  error: string | undefined,
): Promise<void> {
  try {
    await fetch(`/api/bus/ui/surfaces/${encodeURIComponent(id)}/ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, ok, result, error }),
    });
  } catch {
    // 静默 -- ack 失败时上层 action 已 run, ledger 拿不到 applied 事件就是结果.
  }
}
