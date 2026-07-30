// store/disk-watch — receive external disk-change events from the server watcher
// and fan out editor-local refresh signals. Asset changes refresh panels; scene
// document reload is intentionally not automatic here.
//
import { broadcastAssetsChanged } from './assets-changed';
import { createAssetObserverAdapter } from '../product/asset-producer-adapter';
import {
  ctx,
  scenePath,
  type LastSelfSave,
} from './scene-persistence';

// A disk change that lands within this window after a self-save, on the same
// path and with no edit made since, is treated as our own echo even if the
// byte-compare fails (e.g. the server normalises newlines on Windows).
export const SELF_SAVE_ECHO_WINDOW_MS = 3000;

const normPath = (p: string): string => p.replace(/\\/g, '/');

/** Inputs for {@link isSelfSaveEcho} — pure so the decision is unit-testable
 *  without a WebSocket, timers, or the network. */
export interface SelfSaveEchoInput {
  /** Path the server watcher reported changed (may be undefined). */
  eventPath: string | undefined;
  /** The scene this window is currently editing (null when none). */
  activeScenePath: string | null;
  /** The last save this session recorded (null before any save). */
  lastSelfSave: LastSelfSave | null;
  /** True if an edit landed since the last save (self-echo then impossible). */
  isDirty: boolean;
  /** Current epoch ms (injected so the time-window is deterministic in tests). */
  now: number;
  /** Reads the current on-disk bytes for a path (null on any failure). */
  readDisk: (path: string) => Promise<string | null>;
  /** Echo time-window; defaults to {@link SELF_SAVE_ECHO_WINDOW_MS}. */
  windowMs?: number;
}

/** Decide whether a reported file change is the echo of THIS window's own save.
 *  Primary signal: the on-disk bytes equal exactly what we wrote. Fallback (for
 *  server-side newline normalisation): same path, within the time-window, and no
 *  edit landed since — so the change can only be our own write. */
export async function isSelfSaveEcho(input: SelfSaveEchoInput): Promise<boolean> {
  const { eventPath, activeScenePath, lastSelfSave, isDirty, now } = input;
  if (!activeScenePath || !eventPath) return false;
  if (normPath(eventPath) !== normPath(activeScenePath)) return false;
  if (!lastSelfSave) return false; // never saved this session → treat as external
  if (normPath(lastSelfSave.path) !== normPath(activeScenePath)) return false;
  const disk = await input.readDisk(activeScenePath);
  // Primary: the file on disk is byte-identical to what we wrote.
  if (disk !== null && disk === lastSelfSave.content) return true;
  // Fallback: within the echo window and no edit since our save.
  const windowMs = input.windowMs ?? SELF_SAVE_ECHO_WINDOW_MS;
  return !isDirty && now - lastSelfSave.at <= windowMs;
}

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
  const observer = createAssetObserverAdapter();
  let ws: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let backoff = 1000;

  // Reads the current on-disk bytes for the active scene via the file API; the
  // pure isSelfSaveEcho consumes this so the decision itself stays testable.
  const readSceneFromDisk = async (path: string): Promise<string | null> => {
    try {
      const r = await fetch(`/api/files?path=${encodeURIComponent(path)}`);
      if (!r.ok) return null;
      const j = (await r.json()) as { content?: string };
      return j.content ?? null;
    } catch {
      return null;
    }
  };

  const onAssetDiskChanged = async (msg: AssetDiskChangedEvent): Promise<void> => {
    if (msg.gameSlug !== ctx.currentSceneId) return;
    const echo = await isSelfSaveEcho({
      eventPath: msg.path,
      activeScenePath: scenePath(),
      lastSelfSave: ctx.lastSelfSave,
      isDirty: ctx.isDirty,
      now: Date.now(),
      readDisk: readSceneFromDisk,
    });
    if (echo) return;
    observer.observe({
      kind: 'asset-change',
      rootId: msg.gameSlug ?? ctx.currentSceneId,
      scope: msg.path ?? msg.gamePath ?? 'assets',
      resourceRevision: msg.change ?? 'external-change',
    });
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
