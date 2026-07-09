/** Map agent manifest `preferredCliProvider` → kernel id used by `/api/cli/chat`.
 *
 *  Kernel ids match `packages/cli/src/kernel/*-kernel.ts` and the Composer
 *  provider picker (`cursor-agent`, `claude-code`, `codex`, …). `null` means
 *  the forgeax-native EventBus path (no CLI subprocess). */

import { listBusPluginsShared, type BusPluginInfo } from './bus-api';

/** Marketplace cli-provider plugin id → runtime kernel id. */
const PREFERRED_CLI_TO_KERNEL: Record<string, string | null> = {
  'forgeax-native': null,
  '@forgeax-plugin/cli-forgeax': null,
  '@forgeax-plugin/cli-claude-code': 'claude-code',
  '@forgeax-plugin/cli-bc': 'claude-code',
  '@forgeax-plugin/cli-codex': 'codex',
  '@forgeax-plugin/cli-cursor-agent': 'cursor-agent',
};

/** Fallback when bus is unavailable (standalone editor / boot race). */
const AGENT_KERNEL_FALLBACK: Record<string, string | null> = {
  'cursor-default': 'cursor-agent',
  'codex-default': 'codex',
  'claude-code-default': 'claude-code',
  'cc-coder': 'claude-code',
};

export function preferredCliProviderToKernel(preferred?: string | null): string | null {
  const key = preferred?.trim();
  if (!key) return null;
  if (key in PREFERRED_CLI_TO_KERNEL) return PREFERRED_CLI_TO_KERNEL[key] ?? null;
  // Already a kernel id (defensive).
  if (key === 'claude-code' || key === 'codex' || key === 'cursor-agent') return key;
  return null;
}

let agentPluginsCache: BusPluginInfo[] | null = null;
let agentPluginsInflight: Promise<BusPluginInfo[]> | null = null;

async function loadAgentPlugins(): Promise<BusPluginInfo[]> {
  if (agentPluginsCache) return agentPluginsCache;
  if (!agentPluginsInflight) {
    agentPluginsInflight = listBusPluginsShared()
      .then((res) => res.items.filter((p) => p.kind === 'agent'))
      .then((items) => {
        agentPluginsCache = items;
        agentPluginsInflight = null;
        return items;
      })
      .catch(() => {
        agentPluginsInflight = null;
        return [] as BusPluginInfo[];
      });
  }
  return agentPluginsInflight;
}

/** Resolve the CLI kernel id for an agent path/display id (e.g. `cursor-default`). */
export async function resolveKernelForAgent(agentId: string): Promise<string | null> {
  const key = agentId.trim();
  if (!key) return null;

  const plugins = await loadAgentPlugins();
  const hit = plugins.find((p) => {
    const id = p.agent?.id;
    if (!id) return false;
    if (id === key) return true;
    return key.startsWith(`${id}#`);
  });
  if (hit?.agent?.preferredCliProvider) {
    return preferredCliProviderToKernel(hit.agent.preferredCliProvider);
  }

  return AGENT_KERNEL_FALLBACK[key] ?? null;
}

/** Test-only: bust the bus agent cache between cases. */
export function _resetAgentCliProviderCacheForTests(): void {
  agentPluginsCache = null;
  agentPluginsInflight = null;
}
