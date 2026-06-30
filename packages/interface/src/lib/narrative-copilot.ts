/** 叙事工坊「完成即重唤醒」闭环（END 侧）。
 *
 *  背景：剧情师 Kotone 是一问一答的 agent —— 用它跑叙事管线时，它在**启动那一轮**里
 *  讲完选型、调 `narrative:start-pipeline`（秒回 runId）后这一轮就结束、随即静默。管线在
 *  后台跑几分钟，跑完是个**后台事件**，没人唤醒 Kotone，于是用户若不再开口就永远等不到
 *  「完成总结」。
 *
 *  本模块补上这一环：监听 Kotone 调用 start-pipeline，轮询叙事后端直到该 run 进入终态，
 *  然后给 Kotone（事件 emitter）投一条 user_input 系统提示，触发它产出完成总结。
 *
 *  为什么放前端、靠 history 轮询：
 *  - `hook:toolResult` 事件**不带工具返回值**，前端拿不到 runId；但叙事后端同源暴露
 *    `/api/narrative/history`（带 status），且后端强制单实例 run，所以「当前在跑的那条」
 *    就是 Kotone 刚起的。
 *  - 前端是同时连着「agent 会话(WS)」和「叙事后端(REST)」的唯一协调者；放后端要跨进程。
 *
 *  START 侧（左栏回填 + 中间预览直播）由 wb-narrative viz 的 useAutoAttach 自包含完成，
 *  不在本模块职责内。 */

import { onSessionEvent, emitForgeaXMessage } from './forgeax-bridge';

const START_TOOL = 'narrative:start-pipeline';
const POLL_MS = 5_000;
/** 安全上限：超过则放弃 watch（避免 zombie run 让定时器永生）。 */
const MAX_WATCH_MS = 40 * 60 * 1_000;

interface NarrativeHistoryEntry {
  key: string;
  id: string | null;
  status?: string;
}

/** 同一 (sid::agent) 同时只跑一个 watcher，避免重复唤醒。 */
const activeWatchers = new Set<string>();

async function fetchNarrativeHistory(): Promise<NarrativeHistoryEntry[]> {
  try {
    const r = await fetch('/api/narrative/history');
    if (!r.ok) return [];
    const j = (await r.json()) as NarrativeHistoryEntry[];
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

function watchRunToCompletion(sid: string, agent: string): void {
  const watcherKey = `${sid}::${agent}`;
  if (activeWatchers.has(watcherKey)) return; // 已在 watch（同一 agent 连点不重复起）
  activeWatchers.add(watcherKey);

  const startedAt = Date.now();
  // 记住「我们确实看到过它在跑」的那条 run —— 只有见过 running 才认它真起来了，
  // 避免 toolCall 后 run 尚未起来就误判「已结束」。
  let seenRunningKey: string | null = null;

  const stop = () => {
    window.clearInterval(timer);
    activeWatchers.delete(watcherKey);
  };

  const timer = window.setInterval(() => {
    void (async () => {
      if (Date.now() - startedAt > MAX_WATCH_MS) {
        stop();
        return;
      }
      const history = await fetchNarrativeHistory();
      if (history.length === 0) return;

      const running = history.find((e) => e.status === 'running' && !!e.id);
      if (running) {
        seenRunningKey = running.key;
        return;
      }

      // 没有 running 了。若我们之前见过它在跑 → 判定结束，取它的终态去唤醒。
      if (seenRunningKey) {
        const entry = history.find((e) => e.key === seenRunningKey);
        const status = entry?.status ?? 'completed';
        stop();
        await nudgeKotone(sid, agent, seenRunningKey, status);
      }
      // 还没见过 running（run 尚未起来 / 起得很快已结束）—— 继续等到超时为止。
    })();
  }, POLL_MS);
}

async function nudgeKotone(
  sid: string,
  agent: string,
  runKey: string,
  status: string,
): Promise<void> {
  const completed = status === 'completed';
  const content = completed
    ? `【叙事工坊 · 系统通知】你刚启动的管线已完成（输出目录：${runKey}）。请用 narrative:get-run-status / narrative:get-story-tree / narrative:read-file 看一下产出，按你剧情师的视角给用户一段完成总结：跑了哪些环节、产出是什么、是否符合用户需求（默认符合，明显跑偏才指出并建议 narrative:regenerate-step）。`
    : `【叙事工坊 · 系统通知】你刚启动的管线已结束，状态为「${status}」（输出目录：${runKey}）。请用 narrative:get-run-status 看一下停在哪一步、为什么，给用户一句说明并建议下一步（narrative:resume-pipeline 续跑 / 重新启动等）。`;

  await emitForgeaXMessage(sid, content, {
    to: agent,
    type: 'user_input',
    // session-stream 据此把它渲染成「叙事工坊」系统来信行，而非伪装成用户气泡。
    payload: { narrativeAutoNudge: true, runKey, runStatus: status },
  }).catch(() => {
    /* 唤醒失败静默 —— 用户仍可手动追问，不阻塞主流程 */
  });
}

/** Boot 时调一次（main.tsx）。按 key 注册，HMR 重载会覆盖旧 handler。 */
export function subscribeNarrativeCopilot(): void {
  onSessionEvent('narrative-copilot', (e) => {
    const ev = e.event;
    if (!ev || ev.type !== 'hook:toolCall') return;
    const payload = ev.payload as { name?: string; toolCall?: { name?: string } };
    const toolName = payload.name ?? payload.toolCall?.name;
    if (toolName !== START_TOOL) return;
    const agent = e.emitterId;
    if (!agent) return;
    watchRunToCompletion(e.sid, agent);
  });
}
