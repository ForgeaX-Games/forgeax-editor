/**
 * Phase A3 — iframe-mounted workbench plugin.
 *
 * Renders the plugin's standalone dev server inside an iframe and wires it to
 * the host RPC channel via `createPluginPort` from `@forgeax/host-sdk`. This
 * is the new path that will eventually replace the import-tree-based
 * `MAINAREA_PLUGIN_LOADERS` map. Today (A3) it's gated behind the
 * `VITE_FX_USE_IFRAME=true` env flag and only kicks in when a plugin
 * manifest declares `entry.standalone`.
 *
 * What we wire on the host side (interface):
 *   - onChat       — plugin → composer text  (TODO B-phase: dispatch into store)
 *   - onToolCall   — plugin → tool registry  (TODO B-phase: real registry)
 *   - surface.subscribe — observe surface.expose for AgentsPanel
 *   - setTheme    — pushed when light/dark or locale changes (TODO)
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
// Type-only — the runtime factories are injected via PanelRenderers so interface
// never statically pulls @forgeax/host-sdk (studio-only) into its module graph.
// The standalone editor shell bundles interface WITHOUT host-sdk present.
import type { PluginPort } from '@forgeax/host-sdk';
import { useTranslation } from '@/i18n';
import type { BusPluginInfo } from '../../lib/bus-api';
import { upsertSurface, removePluginSurfaces } from '../../lib/surface-store';
import { isTrustedMessageOrigin } from '../../lib/trustedOrigins';
import { useAppStore } from '../../store';
import { usePanelRenderers } from '../DockShell/panelRenderers';

/** Split-surface pane (Doc 06 WORKBENCH-THREE-PANE-V2). The plugin's
 *  index.html reads `?pane=` and tags `<body data-pane=...>`; CSS hides the
 *  irrelevant regions so left/center can be embedded as sibling iframes that
 *  sync via same-origin BroadcastChannel. */
export type PluginIframePane = 'left' | 'center';

interface Props {
  plugin: BusPluginInfo;
  pane?: PluginIframePane;
  /** Keep-alive visibility. When false the iframe stays mounted & alive but is
   *  CSS-hidden (no reload), and we push `visibility.changed{visible:false}` so
   *  heavy plugins can pause their render loop. Defaults to true (standalone /
   *  non-keep-alive callers keep the old always-visible behavior). */
  active?: boolean;
  /** Explicit cold-reload counter. The iframe URL embeds this as `fxv`; the URL
   *  is otherwise STABLE for a given plugin id + version + slug, so keep-alive
   *  actually works (switching panels / games no longer reloads the iframe and
   *  drops its WebGPU ctx / WS / scroll). Bump this only when you intend a
   *  deliberate hard reload (e.g. a recovery "重载" button). Defaults to 0. */
  reloadNonce?: number;
}

function buildIframeSrc(
  plugin: BusPluginInfo,
  pane?: PluginIframePane,
  slug?: string | null,
): string | null {
  const sa = plugin.entry?.standalone;
  if (!sa) return null;
  // Three address modes:
  //   1. embeddedAlso=true — plugin ships a built dist served by the host at
  //      /plugins/<id>/. Prefer this when set: the studio doesn't launch the
  //      plugin's own dev server, and declared `port` may collide with other
  //      services (e.g. wb-character's 15173 collides with the engine).
  //   2. plugin declares `port` — use http://<host>:<port>/<readyProbe?>
  //   3. plugin only declares `start` — fall back to /plugins/<id>/.
  const embeddedSrc = `/plugins/${encodeURIComponent(plugin.id.replace(/^@[^/]+\//, ''))}/`;
  let base: string;
  if (sa.embeddedAlso === true) base = embeddedSrc;
  else if (typeof sa.port === 'number') {
    const probe = sa.readyProbe ?? '/';
    const path = probe.startsWith('/') ? probe : `/${probe}`;
    // Match the parent page's protocol. When the Studio UI is served over HTTPS
    // (FORGEAX_INTERFACE_HTTPS=1, e.g. remote-IP access) an `http://` iframe is
    // blocked as mixed content. The plugin dev server must then also serve HTTPS
    // (run.sh passes the studio .tls cert to its vite). Falls back to http://
    // transparently when the parent is http.
    base = `${window.location.protocol}//${window.location.hostname}:${sa.port}${path}`;
  } else base = embeddedSrc;
  // 多游戏：把当前 game slug 喂进 iframe URL，让 wb-scene 等"per-game data"
  // 类型的插件能在自己空间里读出。其它插件忽略此参数即可。
  const params: string[] = [];
  if (pane) params.push(`pane=${encodeURIComponent(pane)}`);
  if (slug) params.push(`slug=${encodeURIComponent(slug)}`);
  if (params.length === 0) return base;
  return base + (base.includes('?') ? '&' : '?') + params.join('&');
}

/** Workbench id for a plugin id — mirrors WbGallery's `m.workbench?.id ??
 *  m.id.replace(/^@forgeax-plugin\//,'')`. We don't have the manifest here, so
 *  use the prefix-strip fallback (matches every current wb-* plugin: wb-anim →
 *  'anim' has workbench.id 'anim', so set the tab to 'wb:anim'... but the
 *  fallback would give 'wb:wb-anim'). To stay correct we special-case the known
 *  workbench ids; unknown plugins fall back to the strip. */
const PLUGIN_TO_WB_ID: Record<string, string> = {
  '@forgeax-plugin/wb-anim': 'anim',
  '@forgeax-plugin/wb-character': 'character',
  '@forgeax-plugin/wb-skill': 'skill',
  '@forgeax-plugin/wb-reel': 'reel',
};

/** localStorage key the host writes the cross-workbench handoff payload to.
 *  Same-origin so the target plugin iframe (e.g. wb-anim) can read it on boot
 *  + via the 'storage' event. Mirrored constant lives in wb-anim's bridge. */
const ANIM_HANDOFF_KEY = 'forgeax:anim-handoff';

/** Resolve the target plugin's workbench tab id + flip the store so MainArea
 *  takes over with the target plugin. Writes the handoff payload (charId/role/
 *  slug) to localStorage first so the target iframe can pick it up. */
function doNavigate(targetPluginId: string, payload?: Record<string, unknown>): void {
  try {
    if (payload && Object.keys(payload).length > 0) {
      window.localStorage.setItem(
        ANIM_HANDOFF_KEY,
        JSON.stringify({ ...payload, targetPluginId, ts: Date.now() }),
      );
    }
  } catch {
    /* localStorage unavailable (private mode) — target falls back to selector */
  }
  const wbId = PLUGIN_TO_WB_ID[targetPluginId] ?? targetPluginId.replace(/^@[^/]+\//, '');
  useAppStore.getState().openWorkbench({ tab: `wb:${wbId}`, expandedPluginId: targetPluginId });
}

export function StandalonePluginIframe({ plugin, pane, active = true, reloadNonce = 0 }: Props): ReactElement {
  const { t } = useTranslation();
  // Host-SDK port factories are injected (studio-only). Absent in the standalone
  // editor shell — but that shell never opens a wb:* plugin, so the wiring effect
  // below simply no-ops when they're missing.
  const { createPluginPort, createWindowTransport } = usePanelRenderers();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState<string | null>(null);
  // Live port handle, so the visibility effect below can push updates after the
  // initial iframe load without re-running the heavy wiring effect.
  const portRef = useRef<PluginPort | null>(null);
  // Mirrors `active` so the (later-invoked) iframe load handler reads the latest
  // value rather than the value captured when the wiring effect first ran.
  const activeRef = useRef(active);
  // STABLE cache key. Was `${version}-${Date.now()}` which defeated keep-alive:
  // any iframe remount (re-parent / reconcile) recomputed Date.now() → new URL →
  // a full cold reload that tore down the WebGPU ctx + WS + scroll on every
  // panel/game switch. Now keyed only on identity (id + version) + an explicit
  // reloadNonce, so the URL stays identical across switches and the browser
  // reuses the live iframe. A deliberate reload bumps reloadNonce.
  const iframeCacheKey = useMemo(
    () => `${plugin.version ?? 'dev'}-${reloadNonce}`,
    [plugin.id, plugin.version, reloadNonce],
  );
  // 当前 game slug。pinnedSlug 是用户显式选中的工程；但用户**没有显式 pin** 时它
  // 为 null —— 历史上此时 iframe 会以"无 slug（全局库）"启动 per-game 插件，而服务端
  // active-game.json 其实指向某个 game。这个**前后端 slug 不一致**正是"新建 1234 工程
  // 却被 demo/旧素材污染"的根因之一：前端以全局态生成/落库，写到了错误的桶。
  //
  // 修复：pinnedSlug 缺失时回落到服务端解析的 activeSlug（沿用 GameSwitcher /
  // FilesPanel 的 `pinnedSlug ?? activeSlug` 既有约定），并在 slug 解析完成前**不挂载**
  // iframe，杜绝 per-game 插件以无 slug 抢跑。
  const pinnedSlug = useAppStore((s) => s.pinnedSlug);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [slugFetched, setSlugFetched] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/workbench/active-slug')
      .then((r) => r.json())
      .then((j: { activeSlug?: string | null }) => {
        if (!cancelled) setActiveSlug(j?.activeSlug ?? null);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setSlugFetched(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const effectiveSlug = pinnedSlug ?? activeSlug;
  // 已显式 pin → 立即可用；否则等服务端 active-slug 回来（finally 一定会置位）。
  const slugReady = pinnedSlug != null || slugFetched;
  const rawSrc = slugReady ? buildIframeSrc(plugin, pane, effectiveSlug) : null;
  const src = rawSrc ? rawSrc + (rawSrc.includes('?') ? '&' : '?') + `fxv=${encodeURIComponent(iframeCacheKey)}` : null;

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !src) return;
    // No host-sdk injected (standalone editor shell) → no plugin RPC. The raw
    // postMessage navigate fallback below still works without it.
    if (!createPluginPort || !createWindowTransport) return;
    let port: PluginPort | null = null;

    // Raw postMessage fallback for plugins still on the legacy PlatformBridge
    // (wb-character/wb-anim) that don't speak host-sdk. They can request a
    // workbench switch with one line:
    //   window.parent.postMessage({ type: 'FORGEAX_NAVIGATE', targetPluginId, payload }, '*')
    // Scoped to this iframe's contentWindow so a hidden keep-alive sibling
    // can't hijack the navigation.
    const onRawMessage = (ev: MessageEvent) => {
      if (ev.source !== iframe.contentWindow) return;
      if (!isTrustedMessageOrigin(ev.origin)) return; // foreign-origin guard
      const d = ev.data as { type?: string; targetPluginId?: string; payload?: Record<string, unknown> } | null;
      if (!d || d.type !== 'FORGEAX_NAVIGATE' || !d.targetPluginId) return;
      doNavigate(d.targetPluginId, d.payload);
    };
    window.addEventListener('message', onRawMessage);

    const onLoad = () => {
      const win = iframe.contentWindow;
      if (!win) {
        setError('iframe contentWindow unavailable');
        return;
      }
      const transport = createWindowTransport({
        target: win,
        // Same-origin in dev (vite proxy) and same-host:port for now.
        targetOrigin: '*',
        expectedSource: () => iframe.contentWindow,
      });
      port = createPluginPort({
        pluginId: plugin.id,
        transport,
        initial: {
          locale: 'zh',
          theme: 'dark',
          pane: pane ?? 'center',
        },
        onInvalid: (_, reason) => {
          // Silent in prod; useful while debugging A3/A4 wb-character pilot.
          if (import.meta.env.DEV) {
            // eslint-disable-next-line no-console
            console.warn('[StandalonePluginIframe] invalid envelope:', reason);
          }
        },
      });

      // Doc 06 §chat-bridge — plugin → ChatPanel. Plugin calls
      // `host.chat.post(text)` and we route it into the active session as if
      // the user typed it. Attachments aren't yet supported by sendMessage;
      // for now we drop them with a dev-mode warning.
      port.onChat((e) => {
        if (!e.text || !e.text.trim()) return;
        if (e.attachments && e.attachments.length > 0 && import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn('[plugin chat.post] attachments dropped (not yet supported):', plugin.id, e.attachments);
        }
        try {
          void useAppStore.getState().sendMessage(e.text);
        } catch (err) {
          if (import.meta.env.DEV) {
            // eslint-disable-next-line no-console
            console.warn('[plugin chat.post] sendMessage failed:', plugin.id, err);
          }
        }
      });
      // Phase D2 — forward plugin tool.call to /api/tools/call. Caller is
      // marked `workbench` so the server-side ToolRegistry can attribute the
      // call to a plugin iframe rather than confusing it with chat AI.
      port.onToolCall(async (call) => {
        try {
          const r = await fetch('/api/tools/call', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              toolId: call.toolId,
              args: call.args ?? {},
              caller: { kind: 'workbench', agentId: plugin.id },
            }),
          });
          const body = (await r.json()) as { ok: boolean; result?: unknown; error?: string };
          return body.ok
            ? { ok: true, result: body.result }
            : { ok: false, error: body.error ?? 'tool call failed' };
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      });
      port.surface.subscribe((s) => {
        upsertSurface({
          pluginId: plugin.id,
          surfaceId: s.surfaceId,
          actions: s.actions,
          snapshot: s.snapshot,
          updatedAt: Date.now(),
        });
      });

      // 跨工作台跳转:wb-character「生成动画」→ 切到 wb-anim 并透传 charId/role。
      // 走 host-sdk 的 navigate.request envelope。详见 packages/types host-sdk.ts。
      port.onNavigate((e) => doNavigate(e.targetPluginId, e.payload));

      portRef.current = port;
      // Push current keep-alive visibility once the channel is live. Read the
      // ref (not the closed-over `active`) so a plugin that booted while hidden
      // (preloaded in the keep-alive layer) immediately pauses its render loop.
      port.setVisibility(activeRef.current);
    };

    iframe.addEventListener('load', onLoad);
    return () => {
      iframe.removeEventListener('load', onLoad);
      window.removeEventListener('message', onRawMessage);
      port?.close();
      portRef.current = null;
      removePluginSurfaces(plugin.id);
    };
  }, [plugin.id, src, pane, createPluginPort, createWindowTransport]);

  // Keep-alive visibility: push on every `active` flip without tearing down the
  // iframe.
  useEffect(() => {
    activeRef.current = active;
    portRef.current?.setVisibility(active);
  }, [active]);

  if (!src) {
    return (
      <div style={{ padding: 20, color: '#888' }}>
        {t('standalonePlugin.noEntryPrefix')} <code>{plugin.id}</code>{' '}
        {t('standalonePlugin.noEntryMiddle')} <code>entry.standalone</code>{' '}
        {t('standalonePlugin.noEntrySuffix')}
      </div>
    );
  }

  return (
    <div
      className="wb-plugin-iframe-wrap"
      data-active={active ? 'true' : 'false'}
      // Keep-alive hide: `visibility:hidden` (NOT display:none) preserves the
      // WebGL context + layout so re-showing is a one-frame composite with zero
      // JS/network. Off-screen + no pointer events so the hidden iframe can't
      // intercept clicks meant for the visible panel underneath.
      style={
        active
          ? undefined
          : { visibility: 'hidden', pointerEvents: 'none' }
      }
      aria-hidden={active ? undefined : true}
    >
      {error ? (
        <div style={{ padding: 20, color: '#c44' }}>{t('standalonePlugin.iframeLoadFailed', { error })}</div>
      ) : null}
      <iframe
        ref={iframeRef}
        src={src}
        title={plugin.id}
        style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
        // allow-downloads lets plugin frames trigger <a download> saves (e.g.
        // wb-gen3d asset-bundle export); without it Chrome silently blocks any
        // download initiated inside a sandboxed iframe.
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
      />
    </div>
  );
}
