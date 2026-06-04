// forgeax editor-runtime — P0 skeleton.
//
// Mirrors @forgeax-studio/preview-runtime's boot (createApp + VAG postMessage
// bridge + diagnostic overlay) but, instead of dynamically loading a user game,
// it renders an *editable* scene with the SAME forgeax engine the game preview
// uses — so what you edit renders identically to what you play (WYSIWYG).
//
// P1+ layers the React editor panels (hierarchy / inspector / command bus,
// ported from the studio prototype) on top of this canvas.
import {
  Transform,
  MeshFilter,
  MeshRenderer,
  Camera,
  perspective,
  quat,
  HANDLE_CUBE,
  type Handle,
  type MaterialAsset,
} from '@forgeax/engine-runtime';
import { defineComponent } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { createApp } from '@forgeax/engine-app';

const BASE = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
const BASE_MATERIAL_GUID = 'eb5bf6e6-2e47-4d9a-99fd-81843228c9b3';

const root = document.getElementById('app') ?? document.body;

const canvas = document.createElement('canvas');
canvas.style.width = '100%';
canvas.style.height = '100%';
const dpr = Math.min(window.devicePixelRatio || 1, 2);
canvas.width = window.innerWidth * dpr;
canvas.height = window.innerHeight * dpr;
root.appendChild(canvas);

installConsoleBridge();

const app = await createApp(canvas, { shaderManifestUrl: `${BASE}/shaders/manifest.json` });
if (!app.ok) {
  paintDiagnosticMessage(app.error);
  throw new Error('[editor] createApp failed');
}

const { world, renderer } = app.value;
renderer.assets.configurePackIndex(`${BASE}/pack-index.json`);

// DEBUG handle for console probing + parity with preview-runtime.
(window as unknown as Record<string, unknown>).__forgeax_editor = { app: app.value, world, renderer };
void renderer.ready.then((r) => {
  if (!r.ok) console.error('[editor] renderer.ready err:', r.error.code, r.error.expected, r.error.hint, r.error.detail);
});

window.addEventListener('resize', () => {
  const d = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = window.innerWidth * d;
  canvas.height = window.innerHeight * d;
});

await buildEditorScene();
app.value.start();
installFpsReport();
installPreviewControls();

// ── Editor scene (P0): a camera + a ring of spinning cubes so we can verify the
// forgeax render path end-to-end. Replaced by real scene-asset loading in P1. ──
async function buildEditorScene(): Promise<void> {
  const aspect = canvas.width / canvas.height || 1;

  // Try the engine's base material so cubes are lit/colored; fall back to the
  // engine's silent grey default if the pack-index has no entries yet (P0).
  let baseMaterial: Handle<'MaterialAsset', 'unmanaged'> | null = null;
  const guidRes = AssetGuid.parse(BASE_MATERIAL_GUID);
  if (guidRes.ok) {
    const loadRes = await renderer.assets.loadByGuid<MaterialAsset>(guidRes.value);
    if (loadRes.ok) baseMaterial = loadRes.value;
    else console.log('[editor] base material unavailable, using engine default:', loadRes.error.code);
  }

  const Spin = defineComponent('Spin', {
    axisX: { type: 'f32' }, axisY: { type: 'f32' }, axisZ: { type: 'f32' }, speed: { type: 'f32' },
  });

  world.spawn(
    { component: Transform, data: { posY: 0, posZ: 8 } },
    { component: Camera, data: perspective({ fov: Math.PI / 3, aspect }) },
  );

  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2;
    const ax = Math.random() - 0.5, ay = Math.random() - 0.5, az = Math.random() - 0.5;
    const len = Math.hypot(ax, ay, az) || 1;
    const renderData = baseMaterial
      ? { material: renderer.assets.register<MaterialAsset>({
          kind: 'material', parent: baseMaterial,
          paramValues: { baseColor: [0.3 + Math.random() * 0.7, 0.3 + Math.random() * 0.7, 0.3 + Math.random() * 0.7, 1] },
        }).unwrap() }
      : {};
    world.spawn(
      { component: Transform, data: { posX: Math.cos(angle) * 3, posY: (Math.random() - 0.5) * 2, posZ: Math.sin(angle) * 3 } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: renderData },
      { component: Spin, data: { axisX: ax / len, axisY: ay / len, axisZ: az / len, speed: 0.4 + Math.random() * 1.5 } },
    );
  }

  const dq = quat.create(), cur = quat.create();
  world.addSystem({
    name: 'editor-spin',
    queries: [{ with: [Transform, Spin] }],
    resources: ['Time'],
    fn: (qr) => {
      const dt = world.getResource<{ dt: number }>('Time').dt;
      for (const b of qr[0]) {
        for (let i = 0; i < b.entityCount; i++) {
          quat.fromAxisAngle(dq, [b.Spin.axisX[i]!, b.Spin.axisY[i]!, b.Spin.axisZ[i]!], dt * b.Spin.speed[i]!);
          cur[0] = b.Transform.quatX[i]!; cur[1] = b.Transform.quatY[i]!; cur[2] = b.Transform.quatZ[i]!; cur[3] = b.Transform.quatW[i]!;
          quat.multiply(cur, dq, cur);
          b.Transform.quatX[i] = cur[0]; b.Transform.quatY[i] = cur[1]; b.Transform.quatZ[i] = cur[2]; b.Transform.quatW[i] = cur[3];
        }
      }
    },
  });
}

// ── VAG postMessage bridge (parity with preview-runtime so the interface shell
// gets FPS / console / play-pause from the Edit surface too). ──
function installFpsReport(): void {
  let frames = 0, accum = 0;
  app.value.registerUpdate((dt) => {
    frames++; accum += dt;
    if (accum >= 1) {
      const fps = Math.round(frames / accum);
      try { window.parent?.postMessage({ type: 'VAG_FPS_STATS', payload: { fps } }, '*'); } catch { /* cross-origin */ }
      frames = 0; accum = 0;
    }
  });
}

function installConsoleBridge(): void {
  (['log', 'warn', 'error', 'info', 'debug'] as const).forEach((level) => {
    const original = (console[level] as (...a: unknown[]) => void).bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      try {
        const text = args.map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ');
        window.parent?.postMessage({ type: 'VAG_CONSOLE', payload: { level, text, ts: Date.now() } }, '*');
      } catch { /* cross-origin */ }
    };
  });
  window.addEventListener('error', (ev) => {
    try { window.parent?.postMessage({ type: 'VAG_CONSOLE', payload: { level: 'error', text: `${ev.message}\n  at ${ev.filename}:${ev.lineno}`, ts: Date.now() } }, '*'); } catch { /* */ }
  });
  window.addEventListener('unhandledrejection', (ev) => {
    try { window.parent?.postMessage({ type: 'VAG_CONSOLE', payload: { level: 'error', text: `unhandled rejection: ${String(ev.reason)}`, ts: Date.now() } }, '*'); } catch { /* */ }
  });
}

function installPreviewControls(): void {
  window.addEventListener('message', (ev) => {
    const data = ev?.data as { type?: string } | undefined;
    if (!data || typeof data.type !== 'string') return;
    switch (data.type) {
      case 'VAG_PREVIEW_PAUSE': app.value.pause(); break;
      case 'VAG_PREVIEW_PLAY': app.value.resume(); break;
      case 'VAG_PREVIEW_RELOAD': location.reload(); break;
    }
  });
}

function paintDiagnosticMessage(err: unknown): void {
  const overlay = document.createElement('div');
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'display:flex', 'align-items:center', 'justify-content:center',
    'background:#1a1a1f', 'color:#ff8a8a', 'font:14px/1.5 ui-monospace,monospace',
    'padding:24px', 'box-sizing:border-box', 'z-index:99999', 'white-space:pre-wrap', 'text-align:left',
  ].join(';');
  overlay.textContent = [
    '⚠ forgeax editor: WebGPU not available',
    '',
    `createApp error: ${err instanceof Error ? err.message : String(err)}`,
    '',
    'Likely causes:',
    '  • No GPU adapter (headless VM without GPU)',
    '  • Insecure context (WebGPU needs HTTPS or localhost)',
    '  • iframe permissions policy blocking WebGPU',
  ].join('\n');
  document.body.appendChild(overlay);
}
