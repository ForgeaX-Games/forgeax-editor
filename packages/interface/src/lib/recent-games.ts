/** recent-games —— File → 打开最近 submenu 的数据源。
 *
 *  菜单的 `dynamicChildren` 派生器必须**同步**求值 (Radix 在 submenu 展开时同步
 *  渲染 SubContent),而游戏列表来自 async 的 `listGames()`。本模块把二者解耦:
 *    - `warmRecentGames()` —— async 预取,在 File 菜单 dropdown 打开时调用一次,
 *      结果写入模块级缓存;
 *    - `getRecentGames(limit)` —— sync 读缓存,按 mtime 降序 (最近打开在前) 取前
 *      N 个,供 dynamicChildren 派生菜单项。
 *
 *  SSOT 仍是 server 的 /api/workbench/games (listGames);缓存只是"展开前已就绪"
 *  的快照,不是第二真值源 (每次 File 菜单打开都重新 warm)。
 */
import { getWorkbenchClient, hasWorkbenchClient, type GameRow } from '../store-parts/workbench-client';

let cache: GameRow[] = [];

/** Prefetch the game list into the sync cache. Call when the File dropdown
 *  opens so `getRecentGames` has data ready by the time the submenu expands.
 *  Failures leave the previous cache intact (stale is better than empty flash). */
export async function warmRecentGames(): Promise<void> {
  if (!hasWorkbenchClient()) return;
  try {
    const j = await getWorkbenchClient().listGames();
    cache = j.games ?? [];
  } catch {
    /* keep last-known cache on transient failure */
  }
}

/** Sync read: most-recently-modified games first, capped at `limit`.
 *  `GameRow` carries `mtime` under an index signature (typed `unknown`), so
 *  coerce defensively — a missing/NaN mtime sorts last rather than crashing. */
export function getRecentGames(limit = 8): GameRow[] {
  const mt = (g: GameRow): number => {
    const v = Number(g.mtime);
    return Number.isFinite(v) ? v : 0;
  };
  return [...cache].sort((a, b) => mt(b) - mt(a)).slice(0, limit);
}
