// L1 广播流 boot 接线 —— 每页 boot 调一次 `bootBroadcast()`，拉起唯一公共 `/ws`
// 广播连接，并挂上 app-agnostic 的两类帧处理：
//   - `telemetry`         → 喂 telemetry slice（观测；P3 会随观测面下沉到 app）
//   - `workspace-changed` → 全页 reload（后端把 FORGEAX_PROJECT_ROOT 重指到新目录）
//
// daemon-tick-* 帧不在这里处理 —— 那是 chat 的事，chat boot 调 subscribeDaemonTick()
// 自行订阅同一条广播流（见 packages/chat/src/session-store/daemon-tick.ts）。
//
// 取代了原 store.ts 里 module-load 自动 connectDaemonWs 的反模式：现在「建 socket」
// 由 boot 显式发起、全页单例，import store 不再有开 socket 的副作用。
import { connect, subscribeBroadcast } from '../lib/broadcast-stream';
import { SESSION_KEYS } from '../lib/storageKeys';
import { reloadOnceForWorkspace, waitForEngineSettled } from '../lib/workspace-reload';
import { useAppStore, type TelemetryRecord } from '../store';

const _BOOT_FLAG = '__FORGEAX_BOOT_BROADCAST__';
type WithFlag = { [_BOOT_FLAG]?: true };

/** 幂等：多个 boot 路径/HMR 重复调只接线一次；connect 本身也幂等。 */
export function bootBroadcast(): void {
  if (typeof window === 'undefined') return;
  const gt = globalThis as unknown as WithFlag;
  if (!gt[_BOOT_FLAG]) {
    gt[_BOOT_FLAG] = true;

    // Telemetry (trace+log) 主信道：node sidecar → server → WS `{type:'telemetry', records}`。
    subscribeBroadcast('telemetry', (m) => {
      const records = Array.isArray((m as { records?: unknown }).records)
        ? ((m as { records: TelemetryRecord[] }).records)
        : [];
      if (records.length) useAppStore.getState().pushTelemetry(records);
    });

    // Workspace 热切换：server 重指了 FORGEAX_PROJECT_ROOT。旧 root 作用域的 in-tab
    // 状态无法就地重定位，每个打开的 tab 必须整页 reload。用 activeRoot 去重防止 reload 循环。
    // reload 前先等引擎 vite 完成 symlink-flip 触发的 restart（waitForEngineSettled），
    // 否则 reload 后新挂的 PlaySurface 会撞上重启中的引擎 → 预览再 reload 多次（todo 005）。
    subscribeBroadcast('workspace-changed', (m) => {
      void (async () => {
        try {
          const next = (m as { absPath?: string }).absPath ?? '';
          const prev = sessionStorage.getItem(SESSION_KEYS.activeRoot) ?? '';
          if (next && next === prev) return;
          if (next) sessionStorage.setItem(SESSION_KEYS.activeRoot, next);
          await waitForEngineSettled((m as { activeSlug?: string }).activeSlug);
          reloadOnceForWorkspace();
        } catch { /* non-browser ctx */ }
      })();
    });
  }
  // 每次都确保连接活着（幂等）。
  connect();
}
