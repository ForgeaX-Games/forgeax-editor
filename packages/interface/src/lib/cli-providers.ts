/** /api/cli/health → 旧 /api/cli-providers 格式适配层。
 *
 *  历史背景：
 *  - 旧路径 `/api/cli-providers` 由删掉的"统一 chat daemon"提供，UI 各处轮询
 *    它显示 provider 健康灯。
 *  - 新路径 `/api/cli/health` 来自 R3 阶段独立 cli-provider 桥
 *    (`packages/server/src/api/cli/chat.ts`)，所有响应附 `Deprecation: true`
 *    header —— 它本身也是临时的，最终会被 `commands.attach_script_agent` 取代。
 *  - 本模块只做字段 mapping，让旧 UI 代码无感切回上游，避免在 6+ 个地方重复
 *    解构。等 commands 接管之后，整个文件可以删。
 *
 *  返回形态对齐旧 dashboard-api `ProviderHealth` / Composer `CliProviderInfo`：
 *    { id, displayName, health: { ok, detail }, capabilities }
 *
 *  Display name fallback table：与 Composer 既有 PROVIDER_DISPLAY_FALLBACK
 *  保持一致，集中维护一份。 */

export interface CliProviderInfo {
  id: string;
  displayName: string;
  health: { ok: boolean; detail?: string };
  capabilities: Record<string, boolean>;
}

const PROVIDER_DISPLAY: Record<string, string> = {
  "forgeax": "ForgeaX CLI",
  "claude-code": "the reference agent CLI",
  "codex": "OpenAI Codex",
  "cursor-agent": "Cursor Agent",
};

interface RawCliHealth {
  ok?: boolean;
  providers?: Array<{
    id: string;
    ok?: boolean;
    detail?: string;
    capabilities?: Record<string, boolean>;
  }>;
}

/** Single source of truth for the /api/cli/health → CliProviderInfo[] mapping.
 *  `force` is currently ignored upstream (R3 桥每次都打到 provider.health) but
 *  保留参数兼容旧 dashApi.providers(true) caller。 */
export async function fetchCliProviders(
  force = false,
): Promise<{ providers: CliProviderInfo[]; cachedAt: number }> {
  void force; // R3: upstream `/api/cli/health` always lives-checks.
  const r = await fetch("/api/cli/health");
  if (!r.ok) throw new Error(`/api/cli/health ${r.status}`);
  const j = (await r.json()) as RawCliHealth;
  const providers: CliProviderInfo[] = (j.providers ?? []).map((p) => ({
    id: p.id,
    displayName: PROVIDER_DISPLAY[p.id] ?? p.id,
    health: { ok: !!p.ok, detail: p.detail },
    capabilities: p.capabilities ?? {},
  }));
  return { providers, cachedAt: Date.now() };
}
