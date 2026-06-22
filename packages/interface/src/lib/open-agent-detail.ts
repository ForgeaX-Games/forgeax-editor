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

export function openAgentDetail(agentId: string): void {
  if (!agentId) return;
  try { localStorage.setItem(STORAGE_KEY, agentId); } catch { /* private mode */ }
  try {
    const bc = new BroadcastChannel(CHANNEL);
    bc.postMessage({ type: 'select-agent', id: agentId });
    bc.close();
  } catch { /* old browser */ }
  const store = useAppStore.getState();
  if (store.activeSid) store.setTabAgent(store.activeSid, agentId);
  store.openWorkbench({ tab: WB_TAB, expandedPluginId: WB_PLUGIN_ID });
}
