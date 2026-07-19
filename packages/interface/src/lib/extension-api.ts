// P2.6a — typed client for /api/bus/* endpoints.
// Mirrors the slim shape returned by packages/server/src/api/bus.ts so the UI
// never depends on full ExtensionManifest fields server-side never exposes.

export interface ExtensionWorkbenchPaneInfo {
  defaultWidth?: number;
  minWidth?: number;
  collapsible?: boolean;
  minHeight?: number;
  scrollable?: boolean;
}

export interface ExtensionWorkbenchInfo {
  id: string;
  icon?: string;
  position?: number;
  panelSize?: 'sm' | 'md' | 'lg';
  hidden?: boolean;
  /** Doc 06 §panes — declared split-pane intent. Sidebar uses `panes.left` to
   *  decide whether to mount an iframe with `?pane=left` instead of the legacy
   *  ExtensionPlaceholder info card. Center pane is rendered by MainArea. */
  panes?: {
    left?: ExtensionWorkbenchPaneInfo;
    center?: ExtensionWorkbenchPaneInfo;
  };
  /** Soft hint — when this workbench is active, the corner agent picker
   *  defaults to this agent's plugin id. User can still pick any session
   *  agent from the dropdown. R1 untouched: this is just a string ref. */
  preferredAgent?: string;
}

// P3.13 — model-binding capability summary exposed via /api/extensions/list.
// Composer reads vendor/channel/roles to render a routing chip strip so the
// kind=model-binding plugin is no longer invisible outside the Bus admin
// panel.
export interface ExtensionModelBindingInfo {
  channel: string;
  vendor: string;
  models: string[];
  roles?: string[];
}

// P2.6g — skill / tool / event / cli-provider capability summaries surfaced by
// BusAdminPanel detail rows. Mirrors the slim shape projected by the server
// (file paths + runner cmd/args + httpAdapter.auth all stripped).
export interface ExtensionSkillInfo {
  id: string;
  trigger: string;
}

export interface ExtensionToolInfo {
  id: string;
  exposedToAI?: boolean;
}

export interface ExtensionEventInfo {
  name: string;
}

export interface ExtensionCliProviderInfo {
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
export interface ExtensionEntryInfo {
  frontend?: string;
  /** Phase A3: standalone iframe-served plugin entry. When `start`/`port` is
   *  set, the host can mount the plugin via an iframe + postMessage RPC
   *  (createExtensionPort). Gated by `VITE_FX_USE_IFRAME=true` until B-phase. */
  standalone?: {
    start?: string;
    port?: number;
    readyProbe?: string;
    embeddedAlso?: boolean;
  };
}

export interface ExtensionAgentInfo {
  id: string;
  role?: string;
  personaFile?: string;
  memoryDir?: string;
  preferredCliProvider?: string;
  defaultLang?: string;
  multiInstance?: boolean;
}

export interface ExtensionInfo {
  id: string;
  version: string;
  kind: string;
  displayName: { zh?: string; en?: string; ja?: string } | string;
  description?: { zh?: string; en?: string; ja?: string } | string;
  icon?: string;
  experimental?: boolean;
  workbench?: ExtensionWorkbenchInfo;
  modelBinding?: ExtensionModelBindingInfo;
  skills?: ExtensionSkillInfo[];
  tools?: ExtensionToolInfo[];
  events?: ExtensionEventInfo[];
  cliProvider?: ExtensionCliProviderInfo;
  agent?: ExtensionAgentInfo;
  entry?: ExtensionEntryInfo;
  /** kind=agent 才有：统一命名。title=「中文职能·英文名」，sub=灰字英文职能。 */
  naming?: { title: string; sub: string };
}

export interface ExtensionListResponse {
  kind: string | null;
  count: number;
  items: ExtensionInfo[];
}

export function pickLang(
  text: ExtensionInfo['displayName'] | ExtensionInfo['description'],
  lang: 'zh' | 'en' = 'zh',
  fallback = '',
): string {
  if (!text) return fallback;
  if (typeof text === 'string') return text;
  return text[lang] ?? text.zh ?? text.en ?? fallback;
}

/**
 * Flat L0 marketplace path hint for BusAdminPanel / Sidebar detail rows.
 * Normalizes `@forgeax-extension/<slug>` and legacy `@forgeax-plugin/<slug>`
 * to `packages/marketplace/extensions/<slug>/forgeax-extension.json`.
 *
 * Deliberately local (id → path): no kind bucket, no PluginSourceDescriptor /
 * plugin-layout dependency (those were reverted with the kind-layout experiment).
 */
export function extensionManifestPathHint(id: string): string {
  const slug = id
    .replace(/^@forgeax-extension\//, '')
    .replace(/^@forgeax-plugin\//, '');
  return `packages/marketplace/extensions/${slug}/forgeax-extension.json`;
}

export async function listExtensions(kind?: string): Promise<ExtensionListResponse> {
  const url = kind
    ? `/api/extensions/list?kind=${encodeURIComponent(kind)}`
    : '/api/extensions/list';
  const empty: ExtensionListResponse = { kind: kind ?? null, count: 0, items: [] };
  const res = await fetch(url);
  // The plugin bus is a studio-only surface (workbench app, front-L2). The
  // standalone editor has NO bus router, so its absence is EXPECTED, not an
  // error — degrade to an empty list either way the "no backend" shows up:
  //   - no `--game`: unknown /api routes fall to the SPA fallback → 200 + html
  //   - with `--game`: the game-backend answers non-bus routes → 404 + json
  // (Before, only the html case degraded; the 404+json slipped past the !ok
  // guard and threw an Uncaught error in DockShell's boot effect.)
  if (!res.ok) return empty;
  if (!res.headers.get('content-type')?.includes('application/json')) {
    return empty;
  }
  return (await res.json()) as ExtensionListResponse;
}

// Shared short-TTL cache + in-flight dedupe for the full (no-kind) plugin
// list. Many surfaces (WorkbenchExtensionHost, Sidebar tiles, BuildBadge, …)
// fetch this concurrently; without dedupe each mount fires its own request and
// a single slow/failed one can leave that panel stuck. `force` bypasses the
// TTL (used by pollers that need to observe a manifest that just gained
// entry.standalone) but still rides any in-flight request.
let _busAllCache: { ts: number; data: ExtensionListResponse } | null = null;
let _busAllInflight: Promise<ExtensionListResponse> | null = null;
const BUS_ALL_TTL_MS = 2000;

export async function listExtensionsShared(opts?: { force?: boolean }): Promise<ExtensionListResponse> {
  if (!opts?.force && _busAllCache && Date.now() - _busAllCache.ts < BUS_ALL_TTL_MS) {
    return _busAllCache.data;
  }
  if (_busAllInflight) return _busAllInflight;
  _busAllInflight = listExtensions()
    .then((data) => {
      _busAllCache = { ts: Date.now(), data };
      return data;
    })
    .finally(() => {
      _busAllInflight = null;
    });
  return _busAllInflight;
}
