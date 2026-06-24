// EditSurface — edit surface component for forgeax editor host.
//
// Runs in the host window, manages editor iframe lifecycle, VAG messaging,
// and asset import. Distinct from #5 chrome surface slot concept.
//
// Props:
//   slug           — the game slug to edit (required, drives iframe src)
//   viewportOnly?  — if true, appends &viewportOnly=1 to the iframe src
//   serverBase?    — optional base URL for API calls (default '' = relative)
//
// Anchors:
//   plan-strategy §2 D-2 (probe + EditorImportError + serverBase prop)
//   plan-strategy §2 D-5 (side-effect-free leaf module, no import of main.tsx)
//   requirements §5 AC-04 (IMPORT_FORMATS / importAsset / FloatingMenu / VAG_SPAWN_ENTITY)
//   requirements §8 E-1 (standalone explicit failure)
//   charter P3 (structured errors)

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { RotateCcw, Maximize2, Minimize2, Import, AlertTriangle } from 'lucide-react';
import { createPortal } from 'react-dom';
import {
  sendVagMessage,
  VagConsoleSchema,
  VagEditorFlushSchema,
  VagFpsStatsSchema,
  VagAssetsChangedSchema,
  VagSpawnEntitySchema,
} from '@forgeax/editor-core/protocol';

// ── Health forwarding ────────────────────────────────────────────────────────
// The studio shell (cross-port parent) can't read this surface's console. Forward
// health signals up so the shell's INFO/health status bar surfaces them. The shell
// listens for `{type:'forgeax:health', level, source, code, message}` (interface
// healthBridge.ts). Plain postMessage — no import of the interface here.
type HealthLevel = 'info' | 'success' | 'warn' | 'error';
function forwardHealth(level: HealthLevel, code: string, message: string): void {
  try {
    window.parent?.postMessage({ type: 'forgeax:health', level, source: 'edit', code, message }, '*');
  } catch { /* parent might be cross-origin / gone */ }
}

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

// ── EditorImportError ──────────────────────────────────────────────────────────

export type EditorImportErrorCode = 'SERVER_UNAVAILABLE' | 'UNKNOWN';

const ERROR_HINTS: Record<EditorImportErrorCode, { hint: string; expected: string }> = {
  SERVER_UNAVAILABLE: {
    hint: 'The forgeax server (:18900) is not reachable from this host. Asset import and workbench features will be disabled. Start the server with `bash start.sh` in the forgeax-studio root.',
    expected: 'A running forgeax server at the configured serverBase endpoint.',
  },
  UNKNOWN: {
    hint: 'An unexpected error occurred during the server probe.',
    expected: 'A valid response from the server probe endpoint.',
  },
};

export class EditorImportError extends Error {
  code: EditorImportErrorCode;
  hint: string;
  expected: string;

  constructor(code: EditorImportErrorCode) {
    const info = ERROR_HINTS[code];
    super(`EditorImportError: ${code} — ${info.hint}`);
    this.name = 'EditorImportError';
    this.code = code;
    this.hint = info.hint;
    this.expected = info.expected;
  }
}

// ── probeServer ────────────────────────────────────────────────────────────────

export interface ProbeResult {
  available: boolean;
  slug?: string | null;
  error?: EditorImportError;
}

export async function probeServer(serverBase?: string): Promise<ProbeResult> {
  const base = serverBase ?? '';
  const url = `${base}/api/workbench/active-slug`;
  try {
    const r = await fetch(url);
    if (!r.ok) {
      return {
        available: false,
        error: new EditorImportError('SERVER_UNAVAILABLE'),
      };
    }
    const j = (await r.json()) as { activeSlug?: string | null };
    return { available: true, slug: j.activeSlug ?? null };
  } catch {
    return {
      available: false,
      error: new EditorImportError('SERVER_UNAVAILABLE'),
    };
  }
}

// ── Asset import ───────────────────────────────────────────────────────────────

type ImportStep = 'uploading' | 'processing' | 'importing' | 'done' | 'error' | null;

const IMPORT_FORMATS = [
  {
    label: '3D Model',
    desc: '.glb  .gltf',
    hint: 'GLB / GLTF 2.0 · mesh + material + animation + skeleton',
    accept: '.glb,.gltf',
  },
  {
    label: 'Image Texture',
    desc: '.png  .jpg  .hdr',
    hint: 'PNG / JPEG (RGBA8) · HDR (float32, env map)',
    accept: '.png,.jpg,.jpeg,.hdr',
  },
  {
    label: 'Audio',
    desc: '.mp3  .wav  .ogg  .aac',
    hint: 'WebAudio decodeAudioData — MP3/WAV universal; OGG Chrome/FF; AAC Safari',
    accept: '.mp3,.wav,.ogg,.aac,.m4a,.flac,.opus',
  },
  {
    label: 'Material Pack',
    desc: '.pack.json',
    hint: 'internal-text-package — MaterialAsset / MeshAsset / SceneAsset',
    accept: '.json',
  },
] as const;

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function importAssetFile(
  file: File,
  slug: string,
  serverBase: string,
): Promise<{ ok: boolean; error?: string; dest?: string }> {
  const dest = `.forgeax/games/${slug}/assets/${file.name}`;
  try {
    const buf = await file.arrayBuffer();
    const data = arrayBufferToBase64(buf);
    const r = await fetch(`${serverBase}/api/files/upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: dest, data }),
    });
    const j = await r.json() as { bytes?: number; error?: string };
    if (!r.ok) return { ok: false, error: j.error ?? `HTTP ${r.status}` };
    return { ok: true, dest };
  } catch (e) {
    return { ok: false, error: (e as Error).message ?? String(e) };
  }
}

// ── EditSurface Props ──────────────────────────────────────────────────────────

export interface EditSurfaceProps {
  slug: string;
  viewportOnly?: boolean;
  serverBase?: string;
}

// ── EditSurface Component ──────────────────────────────────────────────────────

export function EditSurface({ slug, viewportOnly, serverBase }: EditSurfaceProps) {
  const [fps, setFps] = useState<number | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importStep, setImportStep] = useState<ImportStep>(null);
  const [importMsg, setImportMsg] = useState('');
  const [editorAvailable, setEditorAvailable] = useState<boolean | null>(null);
  // Fatal banner — set on a fatal console error from the editor iframe; cleared
  // on a live frame (fps) or explicit reload.
  const [fatal, setFatal] = useState<{ code: string; message: string } | null>(null);
  const [importAnchor, setImportAnchor] = useState<{ top: number; bottom: number; left: number; right: number } | null>(null);
  const importFileRef = useRef<HTMLInputElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);

  const base = serverBase ?? '';

  // ── mount-time probe (D-2) ─────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await probeServer(base);
      if (cancelled) return;
      setEditorAvailable(result.available);
    })();
    return () => { cancelled = true; };
  }, [base]);

  // ── Deferred game-load while hidden (keep-alive contention guard) ────────────
  // The shell's keep-alive layer keeps BOTH the Edit and Play surfaces mounted at
  // once. If the iframe src tracked `slug` directly, switching GAMES would cold-boot
  // the new game's editor here AND the new game's preview in the (hidden) Play iframe
  // simultaneously → two concurrent WebGPU boots wedge the WKWebView GPU process
  // ("切一个新游戏的 edit 又卡死"). So the iframe loads `loadedSlug`, which only
  // advances to the latest `slug` while THIS surface is visible — a hidden surface
  // defers the new game until shown, so only one engine boots at a time. `slug`
  // still loads on first mount (loadedSlug seeded = slug).
  const [loadedSlug, setLoadedSlug] = useState(slug);
  const slugRef = useRef(slug);
  slugRef.current = slug;
  const visibleRef = useRef(true);
  useEffect(() => {
    if (visibleRef.current) setLoadedSlug(slug);
  }, [slug]);

  // ── iframe src ─────────────────────────────────────────────────────────────
  const voParam = viewportOnly ? '&viewportOnly=1' : '';
  const src = `/editor/?scene=${encodeURIComponent(loadedSlug)}${voParam}`;

  // ── Flush editor's pending save on unmount ─────────────────────────────────
  useEffect(() => {
    return () => {
      try { sendVagMessage(iframeRef.current?.contentWindow ?? null, VagEditorFlushSchema, {} as Record<string, never>); } catch { /* cross-origin / already gone */ }
    };
  }, []);

  // ── Auto-pause when hidden (keep-alive background) ──────────────────────────
  // The shell keeps the editor MOUNTED but display:none'd when you switch to Play,
  // so the editor iframe + its WebGPU context survive without a reboot (fixes
  // "Play→Edit 切回去就死掉"). While hidden, pause the editor's render loop so only
  // the visible surface draws; the context stays alive for an instant resume.
  // VAG_PREVIEW_PAUSE/PLAY are handled by edit-runtime installPreviewControls
  // (→ app.pause/resume); raw postMessage is fine (the receiver schema-validates).
  useEffect(() => {
    const el = frameRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      const visible = entries.some((e) => e.isIntersecting);
      visibleRef.current = visible;
      try { iframeRef.current?.contentWindow?.postMessage({ type: visible ? 'VAG_PREVIEW_PLAY' : 'VAG_PREVIEW_PAUSE' }, '*'); } catch { /* iframe gone */ }
      // Becoming visible flushes a game switch deferred while hidden — boots the new
      // game's editor now (and only now, so it never collides with the Play boot).
      if (visible) setLoadedSlug(slugRef.current);
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // ── Import helpers ──────────────────────────────────────────────────────────
  const pickAndImport = useCallback((accept: string) => {
    const inp = importFileRef.current;
    if (inp) inp.accept = accept;
    inp?.click();
    setImportOpen(false);
  }, []);

  const onFileSelected = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file || !slug) return;
    const isModel = /\.(glb|gltf)$/i.test(file.name);
    const baseName = file.name.replace(/\.(glb|gltf)$/i, '');

    try {
      setImportStep('uploading');
      setImportMsg(file.name);
      const res = await importAssetFile(file, slug, base);
      if (!res.ok || !res.dest) {
        setImportStep('error');
        setImportMsg(res.error ?? 'Upload failed');
        return;
      }

      if (!isModel) {
        sendVagMessage(iframeRef.current?.contentWindow ?? null, VagAssetsChangedSchema, { slug } as any);
        setImportStep('done');
        setImportMsg(file.name);
        setTimeout(() => setImportStep(null), 3000);
        return;
      }

      setImportStep('processing');
      const procRes = await fetch(`${base}/api/assets/process-gltf`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: res.dest, slug }),
      });
      if (!procRes.ok) {
        const j = await procRes.json() as { error?: string };
        setImportStep('error');
        setImportMsg(j.error ?? 'Processing failed');
        return;
      }

      setImportStep('importing');
      const sceneRes = await fetch(`${base}/api/assets/import-scene`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: res.dest, mode: 'auto' }),
      });
      const sceneJ = await sceneRes.json() as {
        mode?: string; totalNodes?: number; meshCount?: number;
        entity?: unknown; doc?: unknown; error?: string;
      };
      if (!sceneRes.ok) {
        setImportStep('error');
        setImportMsg(sceneJ.error ?? 'Scene import failed');
        return;
      }

      const spawnMode: 'reference' | 'full' = sceneJ.mode === 'full' ? 'full' : 'reference';
      sendVagMessage(iframeRef.current?.contentWindow ?? null, VagSpawnEntitySchema, {
        mode: spawnMode, entity: sceneJ.entity, doc: sceneJ.doc, name: baseName,
      });
      sendVagMessage(iframeRef.current?.contentWindow ?? null, VagAssetsChangedSchema, { slug } as any);

      setImportStep('done');
      setImportMsg(baseName);
      setTimeout(() => setImportStep(null), 4000);
    } catch (err) {
      setImportStep('error');
      setImportMsg((err as Error).message ?? String(err));
    }
  }, [slug, base]);

  // ── VAG_* message consumption ──────────────────────────────────────────────
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const expectedSource = iframeRef.current?.contentWindow ?? null;
      if (expectedSource && ev.source !== expectedSource) return;

      const t = (ev.data as { type?: unknown } | null)?.type;
      if (typeof t !== 'string' || !t.startsWith('VAG_')) return;

      // Forward the network stream up to the Studio shell (Network panel).
      if (t === 'VAG_NETWORK') {
        try { window.parent?.postMessage(ev.data, '*'); } catch { /* cross-origin */ }
        return;
      }

      switch (t) {
        case 'VAG_FPS_STATS': {
          const r = VagFpsStatsSchema.safeParse(ev.data);
          if (!r.success) { console.warn('VAG_FPS_STATS schema failure', { issues: r.error.issues }); return; }
          setFps(r.data.payload.fps);
          setFatal(null); // a live editor frame means it recovered.
          return;
        }
        case 'VAG_CONSOLE': {
          const r = VagConsoleSchema.safeParse(ev.data);
          if (!r.success) { console.warn('VAG_CONSOLE schema failure', { issues: r.error.issues }); return; }
          const { level, text } = r.data.payload;
          console[level]('[editor]', text);
          // Forward the FULL console stream (all levels) up to the Studio shell so
          // its Console panel (store.consoleLog) shows it — the shell is one frame
          // above this surface and never receives the engine iframe's own
          // VAG_CONSOLE postMessage directly.
          try { window.parent?.postMessage(ev.data, '*'); } catch { /* cross-origin */ }
          // Forward warn+ to the shell health feed; mark fatal region failures.
          if (level === 'error' || level === 'warn') {
            const reason = level === 'error' ? fatalReason(text) : null;
            forwardHealth(level === 'error' ? 'error' : 'warn', reason ? 'scene-instantiate-failed' : 'vag-console', text);
            if (reason) setFatal({ code: 'scene-instantiate-failed', message: reason });
          }
          return;
        }
        // VAG_EDITOR_REF / VAG_EDITOR_OPEN_SOURCE / VAG_ASSETS_CHANGED are NOT
        // consumed by this surface — they target the shell (window.parent) or
        // ep:* panels. They were `safeParse`d-then-discarded here (validation
        // theater); dropped — unknown/unhandled types fall through to ignore.
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // ── Fullscreen ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const onReload = () => {
    const ifr = iframeRef.current;
    if (!ifr) return;
    setFatal(null);
    // eslint-disable-next-line no-self-assign
    ifr.src = ifr.src;
    setFps(null);
  };

  const onFullscreen = () => {
    const el = frameRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen();
  };

  const importDisabled = !slug || importStep === 'uploading' || importStep === 'processing' || importStep === 'importing';

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="preview-mode" data-testid="edit-mode">
      <div className="preview-toolbar top" data-edit-scene={slug}>
        <div className="pt-left">
          <span className="pt-slug">editor · {slug}</span>
          <span className="pt-divider" />
          <span className="pt-fps" title="FPS (editor viewport)">
            {fps == null ? '--' : fps}
          </span>
        </div>
        <div className="pt-center" />
        <div className="pt-right">
          {importStep && (
            <span className={`pt-import-status pt-import-status--${importStep}`} title={importMsg}>
              {importStep === 'uploading' && '↑'}
              {importStep === 'processing' && '⚙'}
              {importStep === 'importing' && '↓'}
              {importStep === 'done' && '✓'}
              {importStep === 'error' && '✗'}
              {' '}{importMsg.length > 28 ? `${importMsg.slice(0, 26)}…` : importMsg}
            </span>
          )}
          <div className="pt-import-wrap">
            <button
              className={`pt-btn${importOpen ? ' selected' : ''}`}
              title="Import asset into game"
              disabled={importDisabled || editorAvailable === false}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setImportAnchor({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
                setImportOpen((o) => !o);
              }}
            >
              <Import size={16} />
            </button>
            {importOpen && (
              <ImportMenu
                anchor={importAnchor}
                formats={IMPORT_FORMATS}
                onSelect={pickAndImport}
                onClose={() => setImportOpen(false)}
              />
            )}
          </div>
          <input ref={importFileRef} type="file" style={{ display: 'none' }} onChange={onFileSelected} />
          <span className="pt-divider" />
          <button className="pt-btn" onClick={onReload} title="Reload editor">
            <RotateCcw size={16} />
          </button>
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
              <div className="pfb-title">Editor failed to render</div>
              <div className="pfb-msg" title={fatal.message}>{fatal.message}</div>
            </div>
            <button className="pfb-retry" type="button" onClick={onReload}>
              <RotateCcw size={14} /> Reload
            </button>
          </div>
        )}
        {editorAvailable === false ? (
          <div className="preview-center">
            <div className="preview-title">Editor runtime unavailable</div>
            <div className="preview-sub">Cannot connect to forgeax server. Asset import is disabled.</div>
            <button className="preview-retry-btn" type="button" onClick={() => setEditorAvailable(null)}>Retry</button>
          </div>
        ) : (
          <iframe
            ref={iframeRef}
            src={src}
            className="preview-iframe"
            title="forgeax editor"
            // `pointer-lock *` is REQUIRED for the FPS Click→requestPointerLock
            // chain inside the game: Chrome 2026 + WebKit (Safari 26) no longer
            // silently inherit pointer lock from same-origin parents, so without
            // this Permissions-Policy entry requestPointerLock is denied
            // (pointerlockerror). On the Tauri desktop app that denial used to
            // fall back to a native CGAssociate cursor-grab whose frozen cursor
            // yields movementX=0 → dead mouse-look. Granting it here lets the
            // real Pointer Lock API engage in BOTH renderers (web + WKWebView).
            allow="xr-spatial-tracking *; fullscreen *; pointer-lock *"
            onMouseDown={(e) => { try { e.currentTarget.contentWindow?.focus(); } catch { /* guard */ } }}
          />
        )}
      </div>
    </div>
  );
}

// ── ImportMenu (inline floating dropdown, self-contained) ──────────────────────

interface ImportMenuProps {
  anchor: { top: number; bottom: number; left: number; right: number } | null;
  formats: ReadonlyArray<{ label: string; desc: string; hint: string; accept: string }>;
  onSelect: (accept: string) => void;
  onClose: () => void;
}

function ImportMenu({ anchor, formats, onSelect, onClose }: ImportMenuProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const style: React.CSSProperties = {
    position: 'fixed',
    zIndex: 'var(--z-menu, 9999)',
  };
  if (anchor) {
    style.top = anchor.bottom + 4;
    style.right = window.innerWidth - anchor.right;
  }

  return createPortal(
    <>
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 'var(--z-menu-backdrop, 9998)' }}
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      />
      <div style={style} role="menu" onContextMenu={(e) => e.preventDefault()} className="pt-import-menu">
        <div className="pt-import-head">Import Asset</div>
        {formats.map((f) => (
          <button key={f.accept} type="button" className="pt-import-item"
            title={f.hint} onClick={() => { onSelect(f.accept); }}>
            <span className="pt-import-label">{f.label}</span>
            <span className="pt-import-desc">{f.desc}</span>
          </button>
        ))}
      </div>
    </>,
    document.body,
  );
}