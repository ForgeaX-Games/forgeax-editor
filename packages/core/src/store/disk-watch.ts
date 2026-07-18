// store/disk-watch — receive external disk-change events from the server watcher
// and fan out editor-local refresh signals. Asset changes refresh panels; scene
// document reload is intentionally not automatic here.
//
import { broadcastAssetsChanged } from './assets-changed';
import { gateway } from './gateway';
import {
  ctx,
  scenePath,
  worldToPack,
} from './scene-persistence';

interface AssetDiskChangedEvent {
  type: 'asset-disk-changed';
  path?: string;
  change?: string;
  gameSlug?: string;
  gamePath?: string;
  assetFileKind?: 'pack' | 'meta' | 'source';
  assetKind?: string;
  sceneGuid?: string;
  parseOk?: boolean;
}

// ── Disk watch: receive external file changes from the server ────────────────
/**
 * Subscribe to the server's disk watcher and fan asset changes into the editor
 * panel bridge. This deliberately does not mutate the live editor world; panels
 * decide how to refetch and render their own data.
 */
export function initDiskWatch(): () => void {
  let ws: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let backoff = 1000;

  const isSelfScenePackEcho = async (msg: AssetDiskChangedEvent): Promise<boolean> => {
    const activeScenePath = scenePath();
    if (!activeScenePath || !msg.path) return false;
    if (msg.path.replace(/\\/g, '/') !== activeScenePath.replace(/\\/g, '/')) return false;
    const currentPack = worldToPack(gateway.doc, ctx.currentSceneGuid ?? undefined);
    if (currentPack === null) return false;
    try {
      const r = await fetch(`/api/files?path=${encodeURIComponent(activeScenePath)}`);
      if (!r.ok) return false;
      const j = (await r.json()) as { content?: string };
      return j.content === currentPack;
    } catch {
      return false;
    }
  };

  const onAssetDiskChanged = async (msg: AssetDiskChangedEvent): Promise<void> => {
    if (msg.gameSlug !== ctx.currentSceneId) return;
    if (await isSelfScenePackEcho(msg)) return;
    broadcastAssetsChanged('pack-changed', 'disk-watch');
  };

  const connect = (): void => {
    if (stopped) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    try { ws = new WebSocket(`${proto}//${location.host}/ws`); }
    catch { return; }
    ws.addEventListener('open', () => { backoff = 1000; });
    ws.addEventListener('message', (ev) => {
      let msg: { type?: string };
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { return; }
      if (msg?.type === 'asset-disk-changed') {
        void onAssetDiskChanged(msg as AssetDiskChangedEvent);
      }
    });
    const retry = (): void => {
      ws = null;
      if (stopped) return;
      retryTimer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 15000);
    };
    ws.addEventListener('close', retry);
    ws.addEventListener('error', () => { try { ws?.close(); } catch { /* */ } });
  };
  connect();

  return () => {
    stopped = true;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    const sock = ws;
    ws = null;
    if (sock) { try { sock.onclose = null; sock.close(); } catch { /* already gone */ } }
  };
}
