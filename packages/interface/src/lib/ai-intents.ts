/** ai-intents —— 右键唤 AI(P1-10):把「对这个对象让 AI 做某事」编码成 **detail 带
 *  指令的 pill** 插进 composer。
 *
 *  为什么是 pill 而不是新通道:pill 的 `detail` 本来就是发送时展开给 AI 的文本
 *  (composer-bridge `expandPills`),把意图模板拼进 detail 就复用了整条既有链路
 *  (chip 展示 / 队列插入 / chat 包零改动),用户还能在 chip 旁补充说明再发。
 *
 *  两个来源:
 *    1. **kind 专属 intent**(本文件 KIND_INTENTS,按 RefDescriptor.kind 键)+ 通用
 *       「问 AI 这是什么」兜底——任何可引用单元右键即得;
 *    2. **从 ActionRegistry derive**:右键落在 `data-fx-action` 元素上时,自动出现
 *       「让 AI 执行此功能」——零手工维护,注册即得(方案 §3C)。
 */
import type { PillPayload } from './composer-bridge';
import { getAction } from './action-registry';

export interface AiIntent {
  /** 菜单显示(会加「AI:」前缀)。 */
  label: string;
  /** 把原 pill 加工成带指令的 detail(发送时展开给 AI 的最终文本)。 */
  buildDetail: (pill: PillPayload) => string;
}

/** 按 RefDescriptor.kind 的专属 intent(SSOT:每类可引用单元的 AI 动作都列在这里)。 */
const KIND_INTENTS: Record<string, AiIntent[]> = {
  'console-row': [
    { label: '解释这个报错', buildDetail: (p) => `请解释下面这条游戏控制台输出的含义与可能原因:\n${p.detail}` },
    { label: '帮我修掉', buildDetail: (p) => `下面这条游戏控制台报错来自当前游戏,请定位原因并修复对应代码:\n${p.detail}` },
  ],
  file: [
    { label: '看看这个文件', buildDetail: (p) => `请读一下这个文件并概述它的职责与关键逻辑:\n${p.detail}` },
  ],
  'preview-game': [
    { label: '给这个游戏提建议', buildDetail: (p) => `请体验性地评审这个游戏(可用 query_world/capture_frame 取真值),给出改进建议:\n${p.detail}` },
  ],
};

const GENERIC_INTENT: AiIntent = {
  label: '问 AI 这是什么',
  buildDetail: (p) => `请解释下面引用的这个对象是什么、当前状态如何:\n${p.detail}`,
};

/** 给一个可引用单元列出 intent(kind 专属在前,通用兜底在后)。 */
export function aiIntentsFor(refKind: string | undefined): AiIntent[] {
  return [...(refKind ? (KIND_INTENTS[refKind] ?? []) : []), GENERIC_INTENT];
}

/** 把「原 pill × intent」加工成插 composer 的意图 pill(chip 显示意图名,detail 是完整指令)。 */
export function intentPill(pill: PillPayload, intent: AiIntent): PillPayload {
  return {
    kind: pill.kind,
    display: `${intent.label}:${pill.display}`,
    icon: '🤖',
    detail: intent.buildDetail(pill),
    tooltip: { title: `🤖 ${intent.label}`, lines: [pill.display] },
  };
}

/** 从 ActionRegistry derive 的右键项(方案 §3C.2):右键落在 data-fx-action 元素上
 *  → 「让 AI 执行此功能」。返回 null = 目标不在任何已登记 action 上。 */
export function actionIntentPill(target: Element): { title: string; pill: PillPayload } | null {
  const el = target.closest<HTMLElement>('[data-fx-action]');
  const id = el?.dataset.fxAction?.trim();
  if (!el || !id) return null;
  const def = getAction(id);
  const title = def?.title ?? el.dataset.fxTitle?.trim() ?? id;
  return {
    title,
    pill: {
      kind: 'tool',
      display: `执行:${title}`,
      icon: '🤖',
      detail: `请通过 ui_invoke 执行 UI action "${id}"(${title})。若需要参数,先用 ui_snapshot { detail:'schema', ids:['${id}'] } 查看 schema。`,
      tooltip: { title: `🤖 让 AI 执行此功能`, lines: [title, id] },
    },
  };
}
