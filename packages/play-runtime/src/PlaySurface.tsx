// PlaySurface — play surface component for forgeax editor host.
//
// Runs in the host window, manages game iframe lifecycle, device emulation,
// and stall detection. Distinct from #5 chrome surface slot concept.
//
// Props: { slug: string }
//
// Anchors:
//   plan-strategy §2 D-5 (side-effect-free leaf module, no import of main.ts)
//   requirements §5 AC-05 (Preview mode device emulation, stall/restart, pause/play)
//   requirements §5 AC-07 (G-2 case A e2e iframe src assertion)

import { useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, RotateCcw, RotateCcwSquare, Maximize2, Minimize2, Monitor, Smartphone, ChevronDown, AlertTriangle } from 'lucide-react';
import {
  sendVagMessage,
  VagConsoleSchema,
  VagDeviceLostSchema,
  VagFpsStatsSchema,
  VagPreviewDisposeSchema,
} from '@forgeax/editor-core/protocol';

// ── Types ──────────────────────────────────────────────────────────────────────

interface Device {
  id: string;
  name: string;
  w: number;
  h: number;
}

const DEVICES: Device[] = [
  { id: 'iphone-16-pro', name: 'iPhone 16 Pro', w: 402, h: 874 },
  { id: 'iphone-se', name: 'iPhone SE', w: 375, h: 667 },
  { id: 'galaxy-s23', name: 'Galaxy S23', w: 360, h: 780 },
  { id: 'ipad-mini', name: 'iPad mini', w: 744, h: 1133 },
];
const DEFAULT_DEVICE = DEVICES[0]!;

type Mode = 'desktop' | 'mobile';
type Orient = 'portrait' | 'landscape';

const FPS_STALL_MS = 500;
const PROBE_INTERVAL_MS = 250;

// ── Health forwarding ────────────────────────────────────────────────────────
// The studio shell (cross-port parent) can't read this surface's console. Forward
// health signals up so the shell's INFO/health status bar surfaces them. The shell
// listens for `{type:'forgeax:health', level, source, code, message}` (interface
// healthBridge.ts). This is plain postMessage — no import of the interface here
// (keeps the editor/interface decoupling intact).
type HealthLevel = 'info' | 'success' | 'warn' | 'error';
function forwardHealth(level: HealthLevel, code: string, message: string): void {
  try {
    window.parent?.postMessage({ type: 'forgeax:health', level, source: 'play', code, message }, '*');
  } catch { /* parent might be cross-origin / gone */ }
}

// Heuristics: which console-error texts mean the Play viewport is fatally broken
// (black/empty), so the shell shows a banner + retry rather than a buried log line.
const FATAL_PATTERNS: RegExp[] = [
  /scene\s+instantiate\s+failed/i,
  /createApp\s+(failed|error)/i,
  /engine\s+init\s+failed/i,
  /no\s+usable\s+backend/i,
  /webgpu\s+(adapter|unavailable|requires|init)/i,
  /failed\s+to\s+resolve\s+(import|module)/i,
  /does\s+not\s+provide\s+an\s+export/i,
  /loadByGuid.*fail/i,
];
function fatalReason(text: string): string | null {
  return FATAL_PATTERNS.some((re) => re.test(text)) ? text : null;
}

// ── Props ──────────────────────────────────────────────────────────────────────

export interface PlaySurfaceProps {
  slug: string;
}

// ── Component ──────────────────────────────────────────────────────────────────

export function PlaySurface({ slug }: PlaySurfaceProps) {
  const [fps, setFps] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [mode, setMode] = useState<Mode>('desktop');
  const [deviceId, setDeviceId] = useState<string>(DEFAULT_DEVICE.id);
  const [orient, setOrient] = useState<Orient>('portrait');
  const [isFirstFrameLoading, setIsFirstFrameLoading] = useState(true);
  // Fatal banner — set when the game iframe reports device-lost / a fatal console
  // error. Cleared on a successful frame (fps heartbeat) or an explicit reload.
  const [fatal, setFatal] = useState<{ code: string; message: string } | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const lastHeartbeatRef = useRef<number>(Date.now());
  const hasReceivedFpsRef = useRef<boolean>(false);

  const device = useMemo(() => DEVICES.find((d) => d.id === deviceId) ?? DEFAULT_DEVICE, [deviceId]);
  const screen = useMemo(
    () => (orient === 'portrait' ? { w: device.w, h: device.h } : { w: device.h, h: device.w }),
    [device, orient],
  );

  // ── VAG_* message consumption ──────────────────────────────────────────────
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const expectedSource = iframeRef.current?.contentWindow ?? null;
      if (expectedSource && ev.source !== expectedSource) return;

      const t = (ev.data as { type?: unknown } | null)?.type;
      if (typeof t !== 'string' || !t.startsWith('VAG_')) return;

      if (t === 'VAG_FPS_STATS') {
        const r = VagFpsStatsSchema.safeParse(ev.data);
        if (!r.success) {
          console.warn('VAG_FPS_STATS schema failure', { issues: r.error.issues });
          return;
        }
        setFps(r.data.payload.fps);
        lastHeartbeatRef.current = Date.now();
        hasReceivedFpsRef.current = true;
        setIsFirstFrameLoading(false);
        // A live frame means the viewport recovered — clear any fatal banner.
        setFatal(null);
        return;
      }

      if (t === 'VAG_DEVICE_LOST') {
        const r = VagDeviceLostSchema.safeParse(ev.data);
        if (!r.success) {
          console.warn('VAG_DEVICE_LOST schema failure', { issues: r.error.issues });
          return;
        }
        setFps(null);
        setIsFirstFrameLoading(true);
        setFatal({ code: 'device-lost', message: 'WebGPU render device lost — the viewport stopped rendering.' });
        forwardHealth('error', 'device-lost', 'WebGPU render device lost — the viewport stopped rendering.');
        const ifr = iframeRef.current;
        if (ifr) {
          setTimeout(() => {
            // eslint-disable-next-line no-self-assign
            ifr.src = ifr.src;
            lastHeartbeatRef.current = Date.now();
          }, 500);
        }
        return;
      }

      if (t === 'VAG_CONSOLE') {
        const r = VagConsoleSchema.safeParse(ev.data);
        if (!r.success) {
          console.warn('VAG_CONSOLE schema failure', { issues: r.error.issues });
          return;
        }
        const { level, text } = r.data.payload;
        console[level]('[play]', text);
        // Forward warn+ to the shell health feed; mark fatal region failures.
        if (level === 'error' || level === 'warn') {
          const reason = level === 'error' ? fatalReason(text) : null;
          forwardHealth(level === 'error' ? 'error' : 'warn', reason ? 'scene-instantiate-failed' : 'vag-console', text);
          if (reason) setFatal({ code: 'scene-instantiate-failed', message: reason });
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // ── Slug switch → reset loading state ─────────────────────────────────────
  useEffect(() => {
    setIsFirstFrameLoading(true);
    hasReceivedFpsRef.current = false;
  }, [slug]);

  // ── Stall detection ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!isPlaying) return;
    const id = setInterval(() => {
      if (!hasReceivedFpsRef.current) return;
      const elapsed = Date.now() - lastHeartbeatRef.current;
      if (elapsed > FPS_STALL_MS) setIsFirstFrameLoading(true);
    }, 100);
    return () => clearInterval(id);
  }, [slug, isPlaying]);

  // ── Vite restart probe ────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let consecutiveDown = 0;
    let observed = 0;
    let confirmedDown = false;
    let lastReloadAt = 0;
    let reloadCount = 0;
    const MAX_PROBE_RELOADS = 3;
    const DOWN_CONFIRM_TICKS = 2;

    const tick = async () => {
      if (cancelled) return;
      if (hasReceivedFpsRef.current) {
        timer = setTimeout(tick, PROBE_INTERVAL_MS);
        return;
      }
      let up = false;
      try {
        const r = await fetch(`/preview/?game=${encodeURIComponent(slug)}`, {
          method: 'GET',
          cache: 'no-store',
        });
        up = r.ok;
        try { await r.body?.cancel(); } catch { /* */ }
      } catch { up = false; }
      if (cancelled) return;
      observed++;
      if (!up) {
        consecutiveDown++;
        if (consecutiveDown >= DOWN_CONFIRM_TICKS) confirmedDown = true;
      } else {
        const recovered = confirmedDown;
        consecutiveDown = 0;
        confirmedDown = false;
        const armed = !hasReceivedFpsRef.current;
        const underBudget = reloadCount < MAX_PROBE_RELOADS;
        if (recovered && armed && underBudget && observed > DOWN_CONFIRM_TICKS && Date.now() - lastReloadAt > 800) {
          lastReloadAt = Date.now();
          reloadCount++;
          const ifr = iframeRef.current;
          if (ifr) {
            try { sendVagMessage(ifr.contentWindow ?? null, VagPreviewDisposeSchema, {} as Record<string, never>); } catch { /* */ }
            setTimeout(() => {
              // eslint-disable-next-line no-self-assign
              ifr.src = ifr.src;
              lastHeartbeatRef.current = Date.now();
              hasReceivedFpsRef.current = false;
              setIsFirstFrameLoading(true);
              setFps(null);
            }, 100);
          }
        }
      }
      if (!cancelled) timer = setTimeout(tick, PROBE_INTERVAL_MS);
    };

    void tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [slug]);

  // ── Fullscreen ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // ── Controls ──────────────────────────────────────────────────────────────
  const sendToGame = (type: string) => {
    iframeRef.current?.contentWindow?.postMessage({ type }, '*');
  };

  const onPlayPause = () => {
    const next = !isPlaying;
    sendToGame(next ? 'VAG_PREVIEW_PLAY' : 'VAG_PREVIEW_PAUSE');
    setIsPlaying(next);
  };

  const onReload = () => {
    const ifr = iframeRef.current;
    if (!ifr) return;
    try { sendVagMessage(ifr.contentWindow ?? null, VagPreviewDisposeSchema, {} as Record<string, never>); } catch { /* */ }
    setFatal(null);
    setTimeout(() => {
      // eslint-disable-next-line no-self-assign
      ifr.src = ifr.src;
      setFps(null);
      lastHeartbeatRef.current = Date.now();
      hasReceivedFpsRef.current = false;
      setIsFirstFrameLoading(true);
      setIsPlaying(true);
    }, 150);
  };

  const onFullscreen = () => {
    const el = frameRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen();
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="preview-mode">
      <div className="preview-toolbar top" data-game-slug={slug}>
        <div className="pt-left">
          <span className="pt-slug">games/{slug}</span>
          <span className="pt-divider" />
          <span className="pt-fps" title="FPS (realtime)">
            {fps == null ? '--' : fps}
          </span>
        </div>
        <div className="pt-center">
          <button className="pt-btn" onClick={onPlayPause} title={isPlaying ? 'Pause game' : 'Resume game'}>
            {isPlaying ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <button className="pt-btn" onClick={onReload} title="Reload preview">
            <RotateCcw size={16} />
          </button>
        </div>
        <div className="pt-right">
          <div className="pt-device-group">
            {mode === 'mobile' && (
              <div className="pt-device-pill">
                <span className="pt-device-name">
                  {device.name} - {screen.w}x{screen.h}
                </span>
                <ChevronDown size={16} />
                <select
                  className="pt-device-select"
                  value={deviceId}
                  onChange={(e) => setDeviceId(e.target.value)}
                  title="Device model"
                >
                  {DEVICES.map((d) => (
                    <option key={d.id} value={d.id}>{d.name} · {d.w}x{d.h}</option>
                  ))}
                </select>
              </div>
            )}
            <button
              className="pt-btn"
              onClick={() => setMode(mode === 'desktop' ? 'mobile' : 'desktop')}
              title={mode === 'desktop' ? 'Switch to mobile' : 'Switch to desktop'}
            >
              {mode === 'desktop' ? <Monitor size={16} /> : <Smartphone size={16} />}
            </button>
          </div>
          <span className="pt-divider" />
          <button className="pt-btn" onClick={onFullscreen} title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
            {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        </div>
      </div>
      <div className="preview-frame" ref={frameRef}>
        {fatal && (
          <div className="preview-fatal-banner" role="alert">
            <AlertTriangle size={16} className="pfb-icon" />
            <div className="pfb-body">
              <div className="pfb-title">Preview failed to render</div>
              <div className="pfb-msg" title={fatal.message}>{fatal.message}</div>
            </div>
            <button className="pfb-retry" type="button" onClick={onReload}>
              <RotateCcw size={14} /> Reload
            </button>
          </div>
        )}
        {mode === 'desktop' ? (
          <iframe
            ref={iframeRef}
            src={`/preview/?game=${encodeURIComponent(slug)}`}
            className="preview-iframe"
            title={`game preview: ${slug}`}
            allow="xr-spatial-tracking *; fullscreen *"
            onMouseDown={(e) => { try { e.currentTarget.contentWindow?.focus(); } catch { /* guard */ } }}
          />
        ) : (
          <div className="preview-mobile-wrap">
            <div className="preview-mobile-frame" style={{ width: screen.w, height: screen.h }}>
              <iframe
                ref={iframeRef}
                src={`/preview/?game=${encodeURIComponent(slug)}`}
                className="preview-iframe-mobile"
                title={`game preview: ${slug}`}
                allow="xr-spatial-tracking *; fullscreen *"
                onMouseDown={(e) => { try { e.currentTarget.contentWindow?.focus(); } catch { /* guard */ } }}
              />
            </div>
            <button
              className="preview-orient-btn"
              onClick={() => setOrient((o) => (o === 'portrait' ? 'landscape' : 'portrait'))}
              title={orient === 'portrait' ? 'Switch to landscape' : 'Switch to portrait'}
            >
              <RotateCcwSquare size={20} />
            </button>
          </div>
        )}
        {isFirstFrameLoading && (
          <div className="preview-loading-overlay" aria-hidden>
            <div className="preview-loading-spinner" />
            <div className="preview-loading-text">Loading game</div>
          </div>
        )}
      </div>
    </div>
  );
}