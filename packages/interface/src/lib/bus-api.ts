// P2.6a — typed client for /api/bus/* endpoints.
// Mirrors the slim shape returned by packages/server/src/api/bus.ts so the UI
// never depends on full PluginManifest fields server-side never exposes.

export interface BusWorkbenchPaneInfo {
  defaultWidth?: number;
  minWidth?: number;
  collapsible?: boolean;
  minHeight?: number;
  scrollable?: boolean;
}

export interface BusWorkbenchInfo {
  id: string;
  icon?: string;
  position?: number;
  panelSize?: 'sm' | 'md' | 'lg';
  hidden?: boolean;
  /** Doc 06 §panes — declared split-pane intent. Sidebar uses `panes.left` to
   *  decide whether to mount an iframe with `?pane=left` instead of the legacy
   *  BusPluginPlaceholder info card. Center pane is rendered by MainArea. */
  panes?: {
    left?: BusWorkbenchPaneInfo;
    center?: BusWorkbenchPaneInfo;
  };
  /** Soft hint — when this workbench is active, the corner agent picker
   *  defaults to this agent's plugin id. User can still pick any session
   *  agent from the dropdown. R1 untouched: this is just a string ref. */
  preferredAgent?: string;
}

// P3.13 — model-binding capability summary exposed via /api/bus/plugins.
// Composer reads vendor/channel/roles to render a routing chip strip so the
// kind=model-binding plugin is no longer invisible outside the Bus admin
// panel.
export interface BusModelBindingInfo {
  channel: string;
  vendor: string;
  models: string[];
  roles?: string[];
}

// P2.6g — skill / tool / event / cli-provider capability summaries surfaced by
// BusAdminPanel detail rows. Mirrors the slim shape projected by the server
// (file paths + runner cmd/args + httpAdapter.auth all stripped).
export interface BusSkillInfo {
  id: string;
  trigger: string;
}

export interface BusToolInfo {
  id: string;
  exposedToAI?: boolean;
}

export interface BusEventInfo {
  name: string;
}

export interface BusCliProviderInfo {
  id: string;
  displayName: string;
  models?: string[];
  capabilities: {
    streaming: boolean;
    thinking: boolean;
    toolCalls: boolean;
    subAgents: boolean;
    sessions: boolean;
  };
}

// P4.93 — relative entry.frontend path (e.g. './src/panel.tsx'). Mirrors
// BusEntrySlim on the server; backend/standalone/manifest entry fields stay
// stripped server-side. BusAdminPanel renders this in the expanded detail
// row alongside the existing manifest hint path.
export interface BusEntryInfo {
  frontend?: string;
  /** Phase A3: standalone iframe-served plugin entry. When `start`/`port` is
   *  set, the host can mount the plugin via an iframe + postMessage RPC
   *  (createPluginPort). Gated by `VITE_FX_USE_IFRAME=true` until B-phase. */
  standalone?: {
    start?: string;
    port?: number;
    readyProbe?: string;
    embeddedAlso?: boolean;
  };
}

export interface BusPluginInfo {
  id: string;
  version: string;
  kind: string;
  displayName: { zh?: string; en?: string; ja?: string } | string;
  description?: { zh?: string; en?: string; ja?: string } | string;
  icon?: string;
  experimental?: boolean;
  workbench?: BusWorkbenchInfo;
  modelBinding?: BusModelBindingInfo;
  skills?: BusSkillInfo[];
  tools?: BusToolInfo[];
  events?: BusEventInfo[];
  cliProvider?: BusCliProviderInfo;
  entry?: BusEntryInfo;
  /** kind=agent 才有：统一命名。title=「中文职能·英文名」，sub=灰字英文职能。 */
  naming?: { title: string; sub: string };
}

export interface BusPluginListResponse {
  kind: string | null;
  count: number;
  items: BusPluginInfo[];
}

export function pickLang(
  text: BusPluginInfo['displayName'] | BusPluginInfo['description'],
  lang: 'zh' | 'en' = 'zh',
  fallback = '',
): string {
  if (!text) return fallback;
  if (typeof text === 'string') return text;
  return text[lang] ?? text.zh ?? text.en ?? fallback;
}

export async function listBusPlugins(kind?: string): Promise<BusPluginListResponse> {
  const url = kind
    ? `/api/bus/plugins?kind=${encodeURIComponent(kind)}`
    : '/api/bus/plugins';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  // Standalone (no backend) serves the SPA index.html for unknown /api routes —
  // a 200 with text/html. There is no plugin bus without a server, so degrade
  // to an empty list instead of choking on `<!doctype html>`.
  if (!res.headers.get('content-type')?.includes('application/json')) {
    return { kind: kind ?? null, count: 0, items: [] };
  }
  return (await res.json()) as BusPluginListResponse;
}

// Shared short-TTL cache + in-flight dedupe for the full (no-kind) plugin
// list. Many surfaces (WorkbenchPluginHost, Sidebar tiles, BuildBadge, …)
// fetch this concurrently; without dedupe each mount fires its own request and
// a single slow/failed one can leave that panel stuck. `force` bypasses the
// TTL (used by pollers that need to observe a manifest that just gained
// entry.standalone) but still rides any in-flight request.
let _busAllCache: { ts: number; data: BusPluginListResponse } | null = null;
let _busAllInflight: Promise<BusPluginListResponse> | null = null;
const BUS_ALL_TTL_MS = 2000;

export async function listBusPluginsShared(opts?: { force?: boolean }): Promise<BusPluginListResponse> {
  if (!opts?.force && _busAllCache && Date.now() - _busAllCache.ts < BUS_ALL_TTL_MS) {
    return _busAllCache.data;
  }
  if (_busAllInflight) return _busAllInflight;
  _busAllInflight = listBusPlugins()
    .then((data) => {
      _busAllCache = { ts: Date.now(), data };
      return data;
    })
    .finally(() => {
      _busAllInflight = null;
    });
  return _busAllInflight;
}
