// packages/interface/src/core/extensions/trajectory.ts
//
// 轨迹追踪插件 —— 把「页面上发生的所有操作」作为 AI 可观察上下文出墙。
//
// 页面上每个功能操作(人点按钮 / AI 经 ui_invoke)都过 action-registry 的唯一派发
// 入口 dispatchAction,后者发 UI_ACTION_DISPATCH_EVENT。本插件订阅它、落进
// lib/ui-trajectory 的环形缓冲(人 & AI 都记),并把轨迹从两条通道递给 AI:
//   ① registerStateSlice('ui.trajectory') —— 最近若干条随**每次** ui_snapshot 自动
//      出墙(AI 无需主动拉就知道用户刚才在页面上做了什么);
//   ② registerAction('trajectory.read' / 'trajectory.clear') —— AI/人按需拉取更多/清空。
//
// 与 lib/ui-action-highlight.ts 的分工:那边是给「人」看的 ghost 高亮(闪 AI 那条),
// 本插件是给「AI」看的可读上下文 —— 同一事件源,两个正交消费者。
import type { AppExtension } from '../app-shell/types';
import { registerAction, registerStateSlice } from '../../lib/action-registry';
import {
  TRAJECTORY_MAX,
  clearTrajectory,
  readTrajectory,
  startTrajectoryRecording,
} from '../../lib/ui-trajectory';

/** 随每次 ui_snapshot 内联出墙的尾部条数(压 token;更多靠 trajectory.read 拉)。 */
const SNAPSHOT_TAIL = 20;

export const trajectoryExtension: AppExtension = {
  id: 'trajectory',
  version: '1.0.0',
  setup() {
    const stopRecording = startTrajectoryRecording();

    // ① 观察上下文:最近 N 条操作随每次 ui_snapshot 自动出墙。
    const offSlice = registerStateSlice(
      'ui.trajectory',
      () => readTrajectory({ limit: SNAPSHOT_TAIL }).entries,
    );

    // ② 按需读取(firstClass:模型直接看到这条工具,免一次 snapshot 发现往返)。
    const offRead = registerAction({
      id: 'trajectory.read',
      title: '读取操作轨迹',
      description:
        'Read the recent trajectory of UI operations performed on the page by BOTH the human and the AI, ordered oldest→newest. Every operation dispatched through the action registry is recorded (page mode switches, panel toggles, session/game/role/workbench ops, etc.). Use this to understand what the user just did before asking you something. Params: limit (default 50, max ' +
        TRAJECTORY_MAX +
        '), source ("human"|"ai" to filter by who performed it). Returns { total, count, entries:[{seq,ts,id,title,source,capability,args}] } in the result.',
      schema: {
        type: 'object',
        properties: {
          limit: { type: 'number' },
          source: { type: 'string', enum: ['human', 'ai'] },
        },
      },
      capability: 'read',
      firstClass: true,
      surface: 'ui',
      run: (args) => {
        const limit = typeof args.limit === 'number' ? args.limit : undefined;
        const source = args.source === 'human' || args.source === 'ai' ? args.source : undefined;
        return { status: 'completed', stateDigest: readTrajectory({ limit, source }) };
      },
    });

    const offClear = registerAction({
      id: 'trajectory.clear',
      title: '清空操作轨迹',
      description:
        'Clear the recorded UI operation trajectory buffer. Returns { cleared } — how many entries were removed.',
      capability: 'write',
      surface: 'ui',
      run: () => ({ status: 'completed', stateDigest: { cleared: clearTrajectory() } }),
    });

    return () => {
      stopRecording();
      offSlice();
      offRead();
      offClear();
    };
  },
};
