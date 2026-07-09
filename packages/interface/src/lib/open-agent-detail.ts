// Drill into wb-agent-persona for a specific agent.
//
// The iframe under /plugins/wb-agent-persona/* is same-origin, so we hand off
// the selected agent id via two paths:
//   1. localStorage — survives a fresh iframe load (cold open)
//   2. BroadcastChannel('wb-agent-persona') — wakes an already-loaded iframe
//
// wb-agent-persona/index.html reads localStorage on boot and subscribes to the
// BroadcastChannel for live switches.

import { useAppStore } from '../store';

const WB_TAB = 'wb:wb-agent-persona';
const WB_PLUGIN_ID = '@forgeax-plugin/wb-agent-persona';
const STORAGE_KEY = 'wb-agent-persona:selected-agent-id';
const CHANNEL = 'wb-agent-persona';

/** Runtime orchestrator alias from `/api/workbench/agents` — not a bus agent
 *  plugin, so wb-agent-persona can't resolve it. Degrade to the editable lead
 *  persona (arin), matching GROUP_REGISTRY in wb-agent-persona/index.html. */
const PERSONA_EDITOR_ALIASES: Record<string, string> = {
  forge: 'arin',
};

function personaEditorAgentId(agentId: string): string {
  return PERSONA_EDITOR_ALIASES[agentId] ?? agentId;
}

export interface OpenAgentDetailOptions {
  /**
   * When true (default), also `setTabAgent(activeSid, agentId)` — i.e. switch
   * the chat tab to address this agent directly.
   *
   * When false, only open the persona editor focused on the agent without
   * touching the chat tab. Used by AgentsMainArea for sub-agents inside a
   * subagent-family group: catalog browsing should NOT auto-route the chat
   * to a sub (per 2026-06-22 view-only decision — conversation goes through
   * the lead's delegate_to_subagent, not direct).
   */
  switchChat?: boolean;
}

export function openAgentDetail(
  agentId: string,
  opts: OpenAgentDetailOptions = {},
): void {
  if (!agentId) return;
  const { switchChat = true } = opts;
  const personaId = personaEditorAgentId(agentId);
  try { localStorage.setItem(STORAGE_KEY, personaId); } catch { /* private mode */ }
  try {
    const bc = new BroadcastChannel(CHANNEL);
    bc.postMessage({ type: 'select-agent', id: personaId });
    bc.close();
  } catch { /* old browser */ }
  const store = useAppStore.getState();
  if (switchChat && store.activeSid) store.setTabAgent(store.activeSid, agentId);
  store.openWorkbench({ tab: WB_TAB, expandedPluginId: WB_PLUGIN_ID });
}
