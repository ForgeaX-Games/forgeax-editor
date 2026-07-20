/** Map agent manifest `preferredCliProvider` → kernel id used by `/api/cli/chat`.
 *
 *  Kernel ids match `packages/cli/src/kernel/*-kernel.ts` and the Composer
 *  provider picker (`cursor-agent`, `claude-code`, `codex`, …). `null` means
 *  the forgeax-native EventBus path (no CLI subprocess). */

import { listExtensionsShared, type ExtensionInfo } from './extension-api';

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

let agentExtensionsCache: ExtensionInfo[] | null = null;
let agentExtensionsInflight: Promise<ExtensionInfo[]> | null = null;

async function loadAgentExtensions(): Promise<ExtensionInfo[]> {
  if (agentExtensionsCache) return agentExtensionsCache;
  if (!agentExtensionsInflight) {
    agentExtensionsInflight = listExtensionsShared()
      .then((res) => res.items.filter((p) => p.kind === 'agent'))
      .then((items) => {
        agentExtensionsCache = items;
        agentExtensionsInflight = null;
        return items;
      })
      .catch(() => {
        agentExtensionsInflight = null;
        return [] as ExtensionInfo[];
      });
  }
  return agentExtensionsInflight;
}

/** Resolve the CLI kernel id for an agent path/display id (e.g. `cursor-default`). */
export async function resolveKernelForAgent(agentId: string): Promise<string | null> {
  const key = agentId.trim();
  if (!key) return null;

  const plugins = await loadAgentExtensions();
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
  agentExtensionsCache = null;
  agentExtensionsInflight = null;
}
