/**
 * Phase A3 — iframe-mounted workbench plugin.
 *
 * Renders the plugin's standalone dev server inside an iframe and wires it to
 * the host RPC channel via `createExtensionPort` from `@forgeax/host-sdk`. This
 * is the new path that will eventually replace the import-tree-based
 * `MAINAREA_PLUGIN_LOADERS` map. Today (A3) it's gated behind the
 * `VITE_FX_USE_IFRAME=true` env flag and only kicks in when a plugin
 * manifest declares `entry.standalone`.
 *
 * What we wire on the host side (interface):
 *   - onChat       — plugin → composer text  (TODO B-phase: dispatch into store)
 *   - onToolCall   — plugin → tool registry  (TODO B-phase: real registry)
 *   - surface.subscribe — observe surface.expose for AgentsPanel
 *   - setTheme    — pushed when light/dark or locale changes
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { getLocale, useTranslation } from '@/i18n';
import type { ExtensionInfo } from '../../lib/extension-api';
import { useShellStore } from '../../store';
import { getSessionClient } from '../../store-parts/session-client';
import { getWorkbenchClient } from '../../store';
import { ExtensionIframeHost } from '../ExtensionHost/ExtensionIframeHost';

/** Split-surface pane (Doc 06 WORKBENCH-THREE-PANE-V2). The plugin's
 *  index.html reads `?pane=` and tags `<body data-pane=...>`; CSS hides the
 *  irrelevant regions so left/center can be embedded as sibling iframes that
 *  sync via same-origin BroadcastChannel. */
export type ExtensionIframePane = 'left' | 'center';

interface Props {
  plugin: ExtensionInfo;
  pane?: ExtensionIframePane;
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
  plugin: ExtensionInfo,
  pane?: ExtensionIframePane,
  slug?: string | null,
): string | null {
  const sa = plugin.entry?.standalone;
  if (!sa) return null;
  // Four address modes:
  //   1. embeddedAlso=true — plugin ships a built dist served by the host at
  //      /extensions/<id>/. Prefer this when set: the studio doesn't launch the
  //      plugin's own dev server, and declared `port` may collide with other
  //      services (e.g. wb-character's 15173 collides with the engine).
  //   2. anydev/cloud proxy mode — keep the browser on Studio's HTTPS origin and
  //      let Vite proxy to the plugin's plain-HTTP dev server inside the container.
  //   3. plugin declares `port` — use http://<host>:<port>/<readyProbe?>
  //   4. plugin only declares `start` — fall back to /extensions/<id>/.
  const shortId = plugin.id.replace(/^@[^/]+\//, '');
  const encodedShortId = encodeURIComponent(shortId);
  const embeddedSrc = `/extensions/${encodedShortId}/`;
  let base: string;
  if (sa.embeddedAlso === true) base = embeddedSrc;
  else if (import.meta.env.VITE_FORGEAX_STANDALONE_PROXY === '1') {
    const probe = sa.readyProbe ?? '/';
    const path = probe.startsWith('/') ? probe : `/${probe}`;
    base = `/__fx-plugin/${encodedShortId}${path}`;
  } else if (typeof sa.port === 'number') {
    const probe = sa.readyProbe ?? '/';
    const path = probe.startsWith('/') ? probe : `/${probe}`;
    // Match the parent page's protocol. When the Studio UI is served over HTTPS
    // (FORGEAX_INTERFACE_HTTPS=1, e.g. remote-IP access) an `http://` iframe is
    // blocked as mixed content. The plugin dev server must then also serve HTTPS
    // (run.ts passes the studio .tls cert to its vite). Falls back to http://
    // transparently when the parent is http.
    base = `${window.location.protocol}//${window.location.hostname}:${sa.port}${path}`;
  } else base = embeddedSrc;
  // 多游戏：把当前 game slug 喂进 iframe URL，让 wb-scene 等"per-game data"
  // 类型的插件能在自己空间里读出。其它插件忽略此参数即可。
  const params: string[] = [];
  if (pane) params.push(`pane=${encodeURIComponent(pane)}`);
  if (slug) params.push(`slug=${encodeURIComponent(slug)}`);
  params.push(`locale=${encodeURIComponent(getLocale())}`);
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
  '@forgeax-plugin/wb-game-video': 'gamevideo',
  // ADR 0025 renamed forgeax-plugin → forgeax-extension; keep both until all
  // handoff callers emit the new prefix.
  '@forgeax-extension/wb-anim': 'anim',
  '@forgeax-extension/wb-character': 'character',
  '@forgeax-extension/wb-skill': 'skill',
  '@forgeax-extension/wb-reel': 'reel',
  '@forgeax-extension/wb-game-video': 'gamevideo',
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
  useShellStore.getState().openWorkbench({ tab: `wb:${wbId}`, expandedExtensionId: targetPluginId });
}

export function StandaloneExtensionIframe({ plugin, pane, active = true, reloadNonce = 0 }: Props): ReactElement {
  const { t } = useTranslation();
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
  const pinnedSlug = useShellStore((s) => s.pinnedSlug);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [slugFetched, setSlugFetched] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getWorkbenchClient()
      .getActiveSlug()
      .then((j) => {
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

  const handleNavigate = useCallback((targetPluginId: string, payload?: Record<string, unknown>) => {
    doNavigate(targetPluginId, payload);
  }, []);

  const handleChatPost = useCallback((e: { text: string; attachments?: unknown[] }) => {
    if (!e.text || !e.text.trim()) return;
    if (e.attachments && e.attachments.length > 0 && import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.warn('[plugin chat.post] attachments dropped (not yet supported):', plugin.id, e.attachments);
    }
    const st = useShellStore.getState();
    const sid = st.activeSid;
    if (!sid) return;
    const to = st.tabs.find((tb) => tb.sid === sid)?.agentId ?? undefined;
    void getSessionClient().emitForgeaXMessage(sid, e.text, to ? { to } : {}).catch((err) => {
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn('[plugin chat.post] emit failed:', plugin.id, err);
      }
    });
  }, [plugin.id]);

  const handleToolCall = useCallback(async (call: { toolId: string; args?: unknown }) => {
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
        ? { ok: true as const, result: body.result }
        : { ok: false as const, error: body.error ?? 'tool call failed' };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }, [plugin.id]);

  if (!src) {
    return (
      <div style={{ padding: 20, color: '#888' }}>
        {t('standaloneExtension.noEntryPrefix')} <code>{plugin.id}</code>{' '}
        {t('standaloneExtension.noEntryMiddle')} <code>entry.standalone</code>{' '}
        {t('standaloneExtension.noEntrySuffix')}
      </div>
    );
  }

  return (
    <ExtensionIframeHost
      extensionId={plugin.id}
      src={src}
      pane={pane}
      active={active}
      onNavigate={handleNavigate}
      onChatPost={handleChatPost}
      onToolCall={handleToolCall}
      loadErrorText={(error) => t('standaloneExtension.iframeLoadFailed', { error })}
    />
  );
}
