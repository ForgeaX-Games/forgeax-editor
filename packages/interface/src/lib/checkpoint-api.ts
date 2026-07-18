/** checkpoint-api —— checkpoint 回退点的 REST 包装(server api/sessions.ts 路由)。
 *  与 forgeax-bridge 同款风格:不持状态,调用方显式传 sid。 */

export interface CheckpointEntry {
  msgId: string;
  ts: number;
  /** false = 该消息时刻无游戏目录(纯会话),只能会话回退。 */
  hasCode: boolean;
}

export interface PendingRewindInfo {
  boundaryId: string;
  targetMsgId: string;
  mode: "both" | "conversation" | "code";
  preManifestId: string | null;
  keptDirty: string[];
  overwrite: { safetyManifestId: string; files: string[] } | null;
}

/** 单文件变更明细(server snapshot-store FileDiffStat 镜像)。 */
export interface FileDiffStat {
  path: string;
  status: "added" | "deleted" | "modified";
  insertions: number;
  deletions: number;
  binary: boolean;
}

export interface RewindPreview {
  filesChanged: string[];
  insertions: number;
  deletions: number;
  binaryOrLarge: number;
  /** 逐文件明细;旧 server 可能不返回,消费侧用 `files ?? []`。 */
  files?: FileDiffStat[];
}

async function post<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let detail: string;
    try { detail = ((await r.json()) as { error?: string }).error ?? `HTTP ${r.status}`; }
    catch { detail = `HTTP ${r.status}`; }
    throw new Error(detail);
  }
  return (await r.json()) as T;
}

export async function fetchCheckpoints(
  sid: string,
): Promise<{ checkpoints: CheckpointEntry[]; pending: PendingRewindInfo | null }> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/checkpoints`);
  if (!r.ok) throw new Error(`GET checkpoints ${r.status}`);
  return (await r.json()) as { checkpoints: CheckpointEntry[]; pending: PendingRewindInfo | null };
}

export function rewindPreview(sid: string, msgId: string): Promise<RewindPreview> {
  return post(`/api/sessions/${encodeURIComponent(sid)}/rewind/preview`, { msgId });
}

export function rewindTo(
  sid: string,
  msgId: string,
  mode: "both" | "conversation" | "code",
): Promise<{ boundaryId: string; filesChanged: string[]; keptDirty: string[] }> {
  return post(`/api/sessions/${encodeURIComponent(sid)}/rewind`, { msgId, mode });
}

export function rewindCancel(sid: string, boundaryId: string): Promise<{ keptDirty: string[] }> {
  return post(`/api/sessions/${encodeURIComponent(sid)}/rewind/cancel`, { boundaryId });
}

export function rewindOverwriteDirty(sid: string, boundaryId: string): Promise<{ files: string[] }> {
  return post(`/api/sessions/${encodeURIComponent(sid)}/rewind/overwrite-dirty`, { boundaryId });
}

export function rewindUndoOverwrite(sid: string, boundaryId: string): Promise<{ files: string[] }> {
  return post(`/api/sessions/${encodeURIComponent(sid)}/rewind/undo-overwrite`, { boundaryId });
}
