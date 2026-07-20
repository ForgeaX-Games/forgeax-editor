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
  /** 元数据来源(与 `live` 正交):'disk' = 命中 ~/.forgeax/key/models.json 的富元
   *  数据;'live' = 只在 /v1/models 上、用默认 spec 兜底;'driver' = rented CLI
   *  driver catalog。UI 不再据 disk/live 加徽章。 */
  source?: 'disk' | 'live' | 'driver';
  /** 该 id 当前是否由 live proxy 提供。live 权威时整份列表统一为 true(offline 回退
   *  到盘时统一 false)——UI 的 live 徽章据此「要么全有要么全无」,不再让有本地元数
   *  据的行看起来像非 live。 */
  live?: boolean;
  /** Present when source='driver'. Keeps rented-CLI catalogs separate from gateway models. */
  driverId?: string;
  /** Human-facing label for the driver group. */
  driverLabel?: string;
  /** Rented CLIs report token usage but no local $ cost metering. */
  costMetering?: 'none' | 'gateway';
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

/** Catalog 来自 `~/.forgeax/key/models.json`（disk）与 LiteLLM `/v1/models`（live）
 *  的合并：live 权威时展示集合即 live 那份，disk 只静默补元数据。
 *  返回顺序由 server 端按「强度」排好（claude 族最前 → 版本号降序 → tier），
 *  前端不再二次排序，直接平铺渲染。providerId 非空时返回对应内核的
 *  driver-scoped catalog。 */
export async function listModels(providerId?: string | null): Promise<ModelCatalogEntry[]> {
  return (await listModelsWithMeta(providerId)).models;
}

/** 内核目录回退链(env → kernel.listModels → last-known → static → none)
 *  的命中层元数据。UI 用它渲染空态("目录不可用",而不是假列表)和
 *  「缓存/预置」徽章。gateway 路径(providerId 为空)没有这段。 */
export interface CatalogDriverMeta {
  id: string;
  source: 'env' | 'kernel' | 'last-known' | 'static' | 'none' | string;
  error?: string;
  ids: number;
  cached?: boolean;
}

export interface ModelCatalogWithMeta {
  models: ModelCatalogEntry[];
  driver?: CatalogDriverMeta;
}

/** listModels + driver 元数据透传(内核目录路径需要;见 CatalogDriverMeta)。 */
export async function listModelsWithMeta(providerId?: string | null): Promise<ModelCatalogWithMeta> {
  const args = providerId ? [providerId] : [];
  const data = await callQuery<{ models: ModelCatalogEntry[]; driver?: CatalogDriverMeta }>("list_models", args);
  return { models: data.models ?? [], driver: data.driver };
}

/** Full `list_models` payload including the live-probe summary. Use this when
 *  connectivity must NOT treat disk-only fallback as success (onboarding). */
export async function listModelsWithLive(
  providerId?: string | null,
): Promise<{
  models: ModelCatalogEntry[];
  live: { source: string; error?: string; ids: number };
}> {
  const args = providerId ? [providerId] : [];
  const data = await callQuery<{
    models: ModelCatalogEntry[];
    live: { source: string; error?: string; ids: number };
  }>("list_models", args);
  return {
    models: data.models ?? [],
    live: data.live ?? { source: "disabled", ids: 0 },
  };
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
