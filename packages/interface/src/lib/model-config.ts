// @desc Frontend client for `builtin/commands/models.ts` —— list / get / set
//
// 三个 helper 一律走 `/api/commands/*` 走 transport.ts 的 `{ args }` 协议。统一在
// 这里抛 server 端的 `result.error`，调用方只需 try/catch 即可。
//
// 与 `lib/forgeax-bridge.ts:listSessionAgents` 同款套路（POST query+args）。

export interface ModelCatalogEntry {
  id: string;
  /** ModelSpec 字段透传 —— 调用方按需用 */
  input?: string[];
  reasoning?: boolean;
  contextWindow?: number;
  maxOutput?: number;
  defaultTemperature?: number;
  /** loadModelsCatalog 兜底字段（盘上条目不规整时附原 raw） */
  spec?: unknown;
  /** 'disk' = ~/.forgeax/key/models.json 命中;
   *  'live' = LiteLLM /v1/models 才有, UI 可加 badge 提示用户没本地元数据 */
  source?: 'disk' | 'live';
  /** 用户在 Settings → Models 里隐藏的模型不会出现在 Composer 单选下拉里。
   *  inline (Settings) + multi (ModelLab) 仍展示全量,通过眼睛 icon 切换。 */
  hidden?: boolean;
}

export interface AgentModelState {
  sid: string;
  agentPath: string;
  /** chain[0] ?? null —— UI 只想拿"当前生效哪个"读它 */
  selected: string | null;
  /** 永远归一成 string[]（盘上是 string 也展开成 1 元数组） */
  chain: string[];
  /** 盘上原值（string | string[] | null）—— 想区分"用户写了啥"用它 */
  raw: string | string[] | null;
}

interface CommandResp<T> {
  result?: { ok: boolean; data?: T; error?: string };
}

async function callQuery<T>(name: string, args: string[]): Promise<T> {
  const r = await fetch(`/api/commands/${name}/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ args }),
  });
  // transport.ts 在 result.ok=false 时仍返 500 + body —— 都按 json 解析。
  const j = (await r.json()) as CommandResp<T>;
  if (!j.result?.ok) throw new Error(j.result?.error ?? `${name} failed (HTTP ${r.status})`);
  return j.result.data as T;
}

async function callExecute<T>(name: string, args: string[]): Promise<T> {
  const r = await fetch(`/api/commands/${name}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ args }),
  });
  const j = (await r.json()) as CommandResp<T>;
  if (!j.result?.ok) throw new Error(j.result?.error ?? `${name} failed (HTTP ${r.status})`);
  return j.result.data as T;
}

/** Catalog 来自 `~/.forgeax/key/models.json`（server 实时读盘）。
 *  返回顺序按 JSON 字面顺序，前端不再二次排序，让用户编辑 models.json 控制展示序。 */
export async function listModels(): Promise<ModelCatalogEntry[]> {
  const data = await callQuery<{ models: ModelCatalogEntry[] }>("list_models", []);
  return data.models ?? [];
}

/** 读 agent.json::models.model —— **不**经 AGENT_DEFAULTS deep-merge，
 *  能区分"用户没配"（chain=[]、raw=null）和"显式空 chain"（chain=[]、raw=[]）。 */
export async function getAgentModel(sid: string, agentPath: string): Promise<AgentModelState> {
  return callQuery<AgentModelState>("get_agent_model", [sid, agentPath]);
}

/** 写 agent.json models.model = string[]（单模型也写成 ["MODEL"]）。
 *  已 running 的 agent server 端会自动 controlAgent("restart") 重读盘。 */
export async function setAgentModels(
  sid: string,
  agentPath: string,
  models: string[],
): Promise<{ selected: string; chain: string[]; restarted: boolean }> {
  if (models.length === 0) throw new Error("setAgentModels: at least one model required");
  return callExecute("set_agent_models", [sid, agentPath, ...models]);
}

/** Toggle a model's "show in Composer picker" visibility. Persists to
 *  ~/.forgeax/key/models-hidden.json on the server side. Caller should refresh
 *  the catalog (useModelCatalog.refresh) after a successful toggle so the
 *  single-mode dropdown re-filters. */
export async function setModelHidden(
  id: string,
  hidden: boolean,
): Promise<{ id: string; hidden: boolean; totalHidden: number }> {
  return callExecute("set_model_hidden", [id, hidden ? "1" : "0"]);
}
