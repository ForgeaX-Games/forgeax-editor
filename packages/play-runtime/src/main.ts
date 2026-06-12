import {
  createApp,
  loadGame,
  isLoadGameError,
  type GameEntry,
} from '@forgeax/engine-app';
import { perspective, Camera, Transform } from '@forgeax/engine-runtime';
import {
  sendVagMessage,
  VagConsoleSchema,
  VagFpsStatsSchema,
} from '@forgeax/editor-core/protocol';
import type { GameContext } from './types';

const root = document.getElementById('app') ?? document.body;

// ── Canvas ──
const canvas = document.createElement('canvas');
canvas.style.width = '100%';
canvas.style.height = '100%';
canvas.width = window.innerWidth * Math.min(window.devicePixelRatio, 2);
canvas.height = window.innerHeight * Math.min(window.devicePixelRatio, 2);
root.appendChild(canvas);

// ── Loading overlay ──
// A cold load (worst on a freshly-created game) leaves the canvas BLACK for a
// second or two: WebGPU device init + shader compilation + the async scene fetch/
// instantiate all happen before the first frame, and the clear colour is black —
// so it reads as "broken / crashed". Show a sky-gradient overlay + spinner
// immediately, then fade it out the instant the first frame renders.
const loadingOverlay = document.createElement('div');
loadingOverlay.style.cssText = [
  'position:fixed', 'inset:0', 'display:flex', 'flex-direction:column', 'gap:14px',
  'align-items:center', 'justify-content:center', 'z-index:50', 'pointer-events:none',
  'background:linear-gradient(180deg,#8fb1d6 0%,#c9d8e8 55%,#dbe4d0 100%)',
  'font:14px/1.4 ui-sans-serif,system-ui,sans-serif', 'color:#3a4a5a', 'transition:opacity .3s',
].join(';');
loadingOverlay.innerHTML = '<div style="width:34px;height:34px;border:3px solid rgba(58,74,90,.25);border-top-color:#3a4a5a;border-radius:50%;animation:fx-spin .8s linear infinite"></div><div>加载中…</div>';
const spinStyle = document.createElement('style');
spinStyle.textContent = '@keyframes fx-spin{to{transform:rotate(360deg)}}';
document.head.appendChild(spinStyle);
root.appendChild(loadingOverlay);
let loadingHidden = false;
function hideLoadingOverlay(): void {
  if (loadingHidden) return;
  loadingHidden = true;
  loadingOverlay.style.opacity = '0';
  setTimeout(() => loadingOverlay.remove(), 350);
}

// ── Resolve gameId + validate (needed BEFORE createApp now) ──
// Game slug format (path c): lowercase alphanumeric + hyphens, 2-41 chars.
// Used for the physics gate below + the per-game pack-index URLs further down.
const GAME_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

const qp = new URLSearchParams(location.search);
const rawGameId = qp.get('game') ?? qp.get('slug');
const gameId = (rawGameId && GAME_ID_RE.test(rawGameId)) ? rawGameId : '_template';

// ── Physics gate (per-game opt-in via forge.json "physics") ──
// Physics is OFF by default so non-physics games pay zero rapier-WASM cost. A
// game opts in with forge.json `"physics": "3d"` (or `true` / `"2d"`). We must
// read it BEFORE createApp because the backend + 3-phase tick systems are wired
// at app-construction time. The editor host (editor-runtime) never enables
// physics, so ✎ Edit stays static (props don't fall while you arrange them);
// ▶ Play simulates. forge.json is fetched no-store so a freshly-toggled flag
// takes effect on the next reload.
let physics: 'rapier-3d' | 'rapier-2d' | undefined;
{
  const base = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
  try {
    const fj = await fetch(`${base}/.forgeax/games/${gameId}/forge.json`, { cache: 'no-store' });
    if (fj.ok) {
      const p = ((await fj.json()) as { physics?: unknown } | null)?.physics;
      if (p === '3d' || p === true || p === 'rapier-3d') physics = 'rapier-3d';
      else if (p === '2d' || p === 'rapier-2d') physics = 'rapier-2d';
    }
  } catch { /* no manifest / parse error → physics stays off */ }
}

// ── createApp (replaces manual createRenderer + World + component registration) ──
// engine #311 reshaped createApp: shaderManifestUrl moved off the 2nd-arg
// CreateAppOptions onto the 3rd-arg BundlerOptions. Passing it on the 2nd arg
// is silently dropped (structural subtyping), causing the engine to fall back
// to the bare '/shaders/manifest.json' which 404s + SPA-falls-back to HTML.
const app = await createApp(canvas, physics ? { physics } : {}, {
  shaderManifestUrl: '/preview/shaders/manifest.json',
});

if (!app.ok) {
  hideLoadingOverlay();
  paintDiagnosticMessage(canvas, app.error);
  throw new Error('[engine] createApp failed');
}

const { world, renderer } = app.value;

// ── Pack index (prod loadByGuid path) ──
// Per-game index URL: /preview/pack-index/<gameId>.json
// Falls back to global /pack-index.json when the per-game index 404s
// (old games or _template that have no per-game catalog).
const packBase = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
const perGameUrl = `${packBase}/pack-index/${gameId}.json`;
const globalUrl = `${packBase}/pack-index.json`;
renderer.assets.configurePackIndex(perGameUrl);
// Prefetch the per-game index to detect 404; fall back to global on failure.
(async () => {
  try {
    const res = await fetch(perGameUrl, { method: 'HEAD' });
    if (!res.ok && gameId !== '_template') {
      console.log(`[engine] per-game pack-index ${perGameUrl} returned ${res.status}, falling back to global index`);
      renderer.assets.configurePackIndex(globalUrl);
    }
  } catch {
    // Network error: keep the per-game URL and let the runtime retry.
  }
})();

// DEBUG: expose for console probing
(window as unknown as Record<string, unknown>).__forgeax = { app: app.value, world, renderer };
void renderer.ready.then((r) => {
  console.log('[debug] renderer.ready settled:', r);
  if (!r.ok) console.error('[debug] ready err:', r.error.code, r.error.expected, r.error.hint, r.error.detail);
});

// ── Resize handler ──
window.addEventListener('resize', () => {
  canvas.width = window.innerWidth * Math.min(window.devicePixelRatio, 2);
  canvas.height = window.innerHeight * Math.min(window.devicePixelRatio, 2);
});

// ── FPS mouse capture via NATIVE cursor grab — OPT-IN per game ──
// WKWebView denies the web Pointer Lock API for embedded content, so for
// first-person games we ask the Tauri shell (via the parent window) to freeze
// + hide the OS cursor (CGAssociateMouseAndMouseCursorPosition(false)). This is
// intrusive for the majority of games (top-down / click / WASD): a persistent
// "click to lock" HUD plus grabbing the cursor on click is noise there. So it's
// gated — a game opts in with `"pointerLock": true` (or `"input": "fps"`) in
// its forge.json. Default = off → no HUD, no cursor grab (clean preview).
let wantsPointerLock = false;
if (gameId && gameId !== '_template') {
  try {
    const base = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
    const fj = await fetch(`${base}/.forgeax/games/${gameId}/forge.json`);
    if (fj.ok) {
      const j = (await fj.json()) as { pointerLock?: boolean; input?: string } | null;
      wantsPointerLock = j?.pointerLock === true || j?.input === 'fps';
    }
  } catch { /* no manifest / parse error → stays off */ }
}
// engine-input auto-calls canvas.requestPointerLock() on EVERY canvas click
// (browser-backend onCanvasClick) — that pops Chrome's "cursor hidden, press Esc"
// banner even for top-down / click / WASD games that never use mouse-look. For
// non-FPS games (the default), no-op the canvas's requestPointerLock so the banner
// never appears. FPS games (below) use the native Tauri cursor-grab path instead.
if (!wantsPointerLock) {
  try { (canvas as HTMLCanvasElement & { requestPointerLock: () => void }).requestPointerLock = () => {}; } catch { /* ignore */ }
}
if (wantsPointerLock) {
  const hud = document.getElementById('hud');
  if (hud) hud.style.display = 'block';
  const setHud = (m: string) => { if (hud) hud.textContent = m; };
  canvas.style.cursor = 'crosshair';
  canvas.tabIndex = 0;
  (canvas.style as CSSStyleDeclaration & { outline: string }).outline = 'none';
  let captured = false;
  const post = (capture: boolean) => { try { window.parent.postMessage({ type: 'fx-pointer-capture', capture }, '*'); } catch { /* ignore */ } };
  const setCaptured = (v: boolean) => {
    captured = v;
    post(v);
    setHud(v ? '🎮 已锁定 · 移动鼠标转视角 · ESC 释放' : '🖱️ 点击锁定鼠标 (FPS)');
  };
  setHud('🖱️ 点击锁定鼠标 (FPS)');
  canvas.addEventListener('mousedown', () => { try { window.focus(); canvas.focus(); } catch { /* ignore */ } });
  canvas.addEventListener('click', () => setCaptured(true));
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && captured) setCaptured(false); });
}

// ── GameContext (superset: includes both legacy `renderer` and new `app` fields) ──
const ctx: GameContext = {
  world,
  renderer,
  assets: renderer.assets,
  app: app.value,
  registerUpdate(fn) { app.value.registerUpdate(fn); },
};

// ── loadGame ──
async function resolveGame(id: string): Promise<GameEntry | null> {
  // id is already validated by GAME_ID_RE before reaching here.
  // Non-template slugs that fail validation are replaced with '_template'
  // during URL construction.
  if (id === '_template') {
    console.log("[engine] no game id in URL — open /preview/?game=<slug> to load one; rendering fallback scene");
    return null;
  }
  const base = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
  const gameBase = `${base}/.forgeax/games/${id}`;

  // Entry resolution. The game entry filename is no longer hardcoded: the
  // authoritative source is forge.json's `entry` field (relative to the game
  // dir). The canonical convention is a root-level `main.ts` (sibling to
  // `src/`, which holds the rest of the game code). We still fall back to the
  // legacy `src/main.ts` so games created before the rename keep loading.
  const candidates: string[] = [];
  try {
    const fj = await fetch(`${gameBase}/forge.json`);
    if (fj.ok) {
      const entry = (await fj.json())?.entry;
      if (typeof entry === 'string' && entry) candidates.push(entry.replace(/^\.?\//, ''));
    }
  } catch { /* no forge.json / parse error → fall through to defaults */ }
  for (const fallback of ['main.ts', 'src/main.ts']) {
    if (!candidates.includes(fallback)) candidates.push(fallback);
  }

  const resolver = async () => {
    for (const rel of candidates) {
      const url = `${gameBase}/${rel}`;
      const head = await fetch(url, { method: 'HEAD' });
      const ct = head.headers.get('content-type') ?? '';
      if (head.ok && ct.includes('javascript')) {
        return await import(/* @vite-ignore */ url);
      }
    }
    throw new Error(`module not found: ${id}`);
  };
  const result = await loadGame(id, resolver);
  if (!result.ok) {
    if (isLoadGameError(result.error)) {
      console.log(`[engine] loadGame: ${result.error.code} — using fallback`);
    }
    return null;
  }
  return result.value;
}

const entry = await resolveGame(gameId);
if (entry) {
  await entry(ctx);
} else {
  console.log('[engine] using fallback scene; write games/<id>/main.ts to override');
  world.spawn(
    { component: Transform, data: { posY: 0.6, posZ: 5 } },
    { component: Camera, data: perspective({ fov: 60, aspect: window.innerWidth / window.innerHeight, far: 1000 }) },
  );
}

// ── Start the frame loop ──
app.value.start();

// ── FPS reporting + throttled liveness heartbeat ──
// Studio's PreviewMode treats every VAG_FPS_STATS message as "still rendering"
// evidence: a longer-than-FPS_STALL_MS gap hides the iframe behind the loading
// overlay (vite mid-restart, engine threw, …). Emit the heartbeat at HEARTBEAT_MS
// cadence — a 1 Hz emit would oscillate the parent's 500 ms FPS_STALL_MS gate
// every second on a perfectly-rendering scene (overlay-on / overlay-off flicker).
// Per-frame 60 Hz postMessage across the iframe boundary pressures browser GC
// enough to crash the renderer over time when paired with chat output churn
// (Chrome OUT_OF_MEMORY / error code 5), so throttle to 100 ms — still 5× below
// the parent's 500 ms stall threshold. fps averaging itself stays at 1 Hz; only
// the emit rate is gated.
//
// History: this got lost in 5d4cc4f when engine-src moved out of packages/build
// into this package. Restored from packages/build@22ba730 + 471de60.
const HEARTBEAT_MS = 100;
let frames = 0;
let fpsAccum = 0;
let lastFps = 0;
let lastHeartbeat = 0;
app.value.registerUpdate((dt) => {
  // First frame rendered (scene was instantiated during the awaited entry() above,
  // so frame 1 already shows it) → fade out the loading overlay.
  hideLoadingOverlay();
  frames++;
  fpsAccum += dt;
  if (fpsAccum >= 1) {
    lastFps = Math.round(frames / fpsAccum);
    frames = 0;
    fpsAccum = 0;
  }
  const now = performance.now();
  if (now - lastHeartbeat >= HEARTBEAT_MS) {
    lastHeartbeat = now;
    try {
      sendVagMessage(window.parent, VagFpsStatsSchema, { fps: lastFps });
    } catch { /* parent might be cross-origin */ }
  }
});

// ── Console bridge (VAG_CONSOLE postMessage) ──
// Render errors / AppError / RhiError / EcsError verbosely so the bridged
// text in the parent surface (and DevTools console) carries .code /
// .expected / .hint / .detail (incl. .detail.cause for app-system-update-
// failed) rather than the bare message. Plain JSON.stringify drops Error
// instances + forwards `[object Object]` for nested non-Error structured
// errors, hiding the actual root cause.
// Replacer used by JSON.stringify on .detail / structured payloads so that
// engine errors nested inside (e.g. AppError.detail.cause = EcsError) print
// as "Name code: message | hint=..." rather than collapsing to {} (Error
// instances JSON.stringify to {} by default — non-enumerable name/message).
// Plain Errors fall back to "name: message". Two-level deep is enough for
// the error chains we surface (AppError -> RhiError.detail.webgpuError etc).
function shallowErrorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    const r = value as unknown as Record<string, unknown>;
    const head = typeof r.code === 'string' ? `${value.name} ${r.code}: ${value.message}` : `${value.name}: ${value.message}`;
    const extras: string[] = [];
    if (typeof r.expected === 'string') extras.push(`expected=${r.expected}`);
    if (typeof r.hint === 'string') extras.push(`hint=${r.hint}`);
    return extras.length > 0 ? `${head} | ${extras.join(' | ')}` : head;
  }
  return value;
}

function fmtArg(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a instanceof Error) {
    const r = a as unknown as Record<string, unknown>;
    const parts = [`${a.name}: ${a.message}`];
    if (typeof r.code === 'string') parts.push(`code=${r.code}`);
    if (typeof r.expected === 'string') parts.push(`expected=${r.expected}`);
    if (typeof r.hint === 'string') parts.push(`hint=${r.hint}`);
    // Promote detail.cause to its own line — for AppError 'app-system-
    // update-failed' the cause is the actual root (EcsError, RhiError,
    // host-system Error). Make sure it's not buried inside a JSON blob.
    const detail = r.detail as Record<string, unknown> | undefined;
    if (detail && typeof detail === 'object' && 'cause' in detail) {
      const c = detail.cause;
      if (c instanceof Error) {
        const cr = c as unknown as Record<string, unknown>;
        const head = typeof cr.code === 'string' ? `${c.name} ${cr.code}: ${c.message}` : `${c.name}: ${c.message}`;
        parts.push(`cause=${head}`);
        if (typeof cr.expected === 'string') parts.push(`cause.expected=${cr.expected}`);
        if (typeof cr.hint === 'string') parts.push(`cause.hint=${cr.hint}`);
        if (cr.detail !== undefined) {
          try { parts.push(`cause.detail=${JSON.stringify(cr.detail, shallowErrorReplacer)}`); }
          catch { parts.push(`cause.detail=${String(cr.detail)}`); }
        }
        if (typeof c.stack === 'string') parts.push(`cause.stack=\n${c.stack.split('\n').slice(0, 4).join('\n')}`);
      } else if (c !== undefined) {
        parts.push(`cause=${typeof c === 'string' ? c : JSON.stringify(c, shallowErrorReplacer)}`);
      }
    }
    if (r.detail !== undefined) {
      try { parts.push(`detail=${JSON.stringify(r.detail, shallowErrorReplacer)}`); }
      catch { parts.push(`detail=${String(r.detail)}`); }
    }
    if (typeof a.stack === 'string') parts.push(a.stack.split('\n').slice(0, 4).join('\n'));
    return parts.join(' | ');
  }
  try { return JSON.stringify(a, shallowErrorReplacer); }
  catch { return String(a); }
}
(['log', 'warn', 'error', 'info', 'debug'] as const).forEach((level) => {
  const original = (console[level] as (...args: unknown[]) => void).bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    try {
      const text = args.map(fmtArg).join(' ');
      sendVagMessage(window.parent, VagConsoleSchema, { level, text, ts: Date.now() });
    } catch { /* parent might be cross-origin */ }
  };
});

window.addEventListener('error', (ev) => {
  try {
    sendVagMessage(window.parent, VagConsoleSchema, { level: 'error', text: `${ev.message}\n  at ${ev.filename}:${ev.lineno}`, ts: Date.now() });
  } catch { /* ignore */ }
});
window.addEventListener('unhandledrejection', (ev) => {
  try {
    sendVagMessage(window.parent, VagConsoleSchema, { level: 'error', text: `unhandled rejection: ${String(ev.reason)}`, ts: Date.now() });
  } catch { /* ignore */ }
});

// Forward vite BUILD errors (import-analysis / transform) to VAG_CONSOLE. These
// fire at module-transform time — BEFORE any game code runs — so the console
// wrappers above never see them, and the agent (which can't see the red HMR
// overlay) was blind to "Failed to resolve import './src/foo'" class failures.
// Surfacing them as VAG_CONSOLE errors makes the Studio Console (hence the
// agent) aware the Preview is broken even when nothing executed.
if (import.meta.hot) {
  import.meta.hot.on('vite:error', (payload: { err?: { message?: string; id?: string; loc?: { file?: string; line?: number } } }) => {
    try {
      const err = payload?.err;
      const where = err?.loc?.file ? ` (${err.loc.file}${err.loc.line ? `:${err.loc.line}` : ''})` : err?.id ? ` (${err.id})` : '';
      sendVagMessage(window.parent, VagConsoleSchema, { level: 'error', text: `[vite build] ${err?.message ?? 'build error'}${where}`, ts: Date.now() });
    } catch { /* ignore */ }
  });
}

// ── Pause / Play / Reload (VAG_PREVIEW_* postMessage protocol) ──
window.addEventListener('message', (ev) => {
  const data = ev?.data as { type?: string } | undefined;
  if (!data || typeof data.type !== 'string') return;
  switch (data.type) {
    case 'VAG_PREVIEW_PAUSE':
      app.value.pause();
      break;
    case 'VAG_PREVIEW_PLAY':
      app.value.resume();
      break;
    case 'VAG_PREVIEW_RELOAD':
      location.reload();
      break;
  }
});

// ── Vite HMR ──
if (import.meta.hot) {
  import.meta.hot.on('vite:beforeFullReload', () => {
    console.log('[engine] HMR full reload');
  });
}

// ── Diagnostic overlay (WebGPU unavailable) ──
function paintDiagnosticMessage(_c: HTMLCanvasElement, err: unknown): void {
  const isInsecureRemote = location.protocol === 'http:'
    && location.hostname !== 'localhost'
    && location.hostname !== '127.0.0.1'
    && !location.hostname.startsWith('localhost');

  const overlay = document.createElement('div');
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'display:flex', 'align-items:center', 'justify-content:center',
    'background:#1a1a1f', 'font:14px/1.5 ui-monospace,monospace',
    'padding:24px', 'box-sizing:border-box', 'pointer-events:auto', 'z-index:99999',
    'white-space:pre-wrap', 'text-align:left',
  ].join(';');

  const lines: string[] = [];

  if (isInsecureRemote) {
    overlay.style.color = '#7dff7d';
    lines.push(
      '⚠ WebGPU requires a Secure Context',
      '',
      `Current origin: ${location.origin} (insecure)`,
      '',
      'WebGPU is only available over HTTPS or localhost.',
      'You are accessing via HTTP + non-localhost IP, so the browser blocks WebGPU.',
      '',
      'Fix (pick one):',
      '  1. SSH port-forward: ssh -L 15173:localhost:15173 <server>',
      '     then open http://localhost:15173/preview/',
      '',
      '  2. Chrome flag: chrome://flags/#unsafely-treat-insecure-origin-as-secure',
      `     add "${location.origin}" to the list, relaunch Chrome`,
      '',
      '  3. Set up HTTPS (nginx reverse proxy with self-signed cert)',
    );
  } else {
    overlay.style.color = '#ff8a8a';
    const reason = err
      ? `createApp error: ${err instanceof Error ? err.message : String(err)}`
      : 'WebGPU adapter request returned null';
    lines.push(
      '⚠ Engine init failed',
      '',
      reason,
    );

    // EngineEnvironmentError carries a structured detail with webgpuError /
    // wgpuError — each is a RhiError-shape with code/expected/hint/detail. The
    // outer "no usable backend" message is generic; the inner RhiError is the
    // real cause (often unrelated to GPU adapter — e.g. shader manifest 404
    // returning HTML, asset pipeline failure, etc). Surface it ALL.
    const e = err as Record<string, unknown> | null;
    const detail = (e && typeof e === 'object' ? (e.detail as Record<string, unknown> | undefined) : undefined);
    function dumpInner(label: string, re: unknown): void {
      if (!re || typeof re !== 'object') return;
      const r = re as Record<string, unknown>;
      lines.push('', `── ${label} ──`);
      if (r.message) lines.push(`message:  ${String(r.message)}`);
      if (r.code) lines.push(`code:     ${String(r.code)}`);
      if (r.expected) lines.push(`expected: ${String(r.expected)}`);
      if (r.hint) lines.push(`hint:     ${String(r.hint)}`);
      if (r.detail !== undefined) {
        try { lines.push(`detail:   ${JSON.stringify(r.detail)}`); }
        catch { lines.push(`detail:   ${String(r.detail)}`); }
      }
    }
    if (detail) {
      dumpInner('webgpu (Channel 2)', detail.webgpuError);
      dumpInner('wgpu (Channel 3 fallback)', detail.wgpuError);
    }

    // Only fall back to the generic "likely causes" hint when we have NO
    // structured inner error — otherwise the inner code/hint already pinpoints
    // the actual cause and the generic list misleads.
    const hasInner = detail && (detail.webgpuError || detail.wgpuError);
    if (!hasInner) {
      lines.push(
        '',
        'Likely causes:',
        '  • No GPU adapter available (VM without GPU hardware)',
        '  • Chrome flag chrome://flags/#enable-unsafe-webgpu disabled',
        '  • iframe permissions policy blocking WebGPU',
      );
    }
  }

  overlay.textContent = lines.join('\n');
  document.body.appendChild(overlay);
}
