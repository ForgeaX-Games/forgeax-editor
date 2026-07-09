// EditSurface — edit surface component for forgeax editor host.
//
// Runs in the host window, manages editor iframe lifecycle, VAG messaging,
// and asset import. Distinct from #5 chrome surface slot concept.
//
// Props:
//   slug           — the game slug to edit (required, drives iframe src)
//   viewportOnly?  — if true, appends &viewportOnly=1 to the iframe src
//
// Backend calls go through the same-origin `apiFetch` helper (editor-core). The
// former `serverBase` prop is retired (M4 / plan-strategy D-7): it never carried
// a non-empty value in production — every call was already same-origin `/api`.
//
// Anchors:
//   plan-strategy §2 D-2 (probe + EditorImportError)
//   plan-strategy §2 D-5 (side-effect-free leaf module, no import of main.tsx)
//   plan-strategy §2 D-7 (serverBase retirement — same-origin apiFetch)
//   requirements §5 AC-04 (IMPORT_FORMATS / importAsset / FloatingMenu / VAG_SPAWN_ENTITY)
//   requirements §8 E-1 (standalone explicit failure)
//   requirements AC-07 (createDefaultApiClient converged to apiFetch)
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
import { apiFetch, buildSpawnEntityFromDragRef, cookFbxMeta, cookGltfMeta, recoverMeshOriginalMaterialGuids, panelBridge, type DragAssetRef } from '@forgeax/editor-core';

// ── Health forwarding ────────────────────────────────────────────────────────
// Forward structured health signals from this surface to the studio shell's
// health status bar via postMessage. The shell (healthBridge) listens for
// `{type:'forgeax:health', level, source, code, message}` (interface
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

// Imported-mesh material recovery (path 2, feat-20260708 M1): both spawn paths
// share ONE helper `recoverMeshOriginalMaterialGuids` (editor-core/assets/
// drag-asset-spawn.ts) — see plan-strategy D-4 / AC-02. Path 2 (this file, VAG
// spawn) and path 1 (core spawn-asset-ref.ts, gateway.dispatch) both import it
// downward from core (legal `core <- edit-runtime` direction), so there is no
// per-path duplication.

// ── EditorImportError ──────────────────────────────────────────────────────────

export type EditorImportErrorCode = 'SERVER_UNAVAILABLE' | 'UNKNOWN';

const ERROR_HINTS: Record<EditorImportErrorCode, { hint: string; expected: string }> = {
  SERVER_UNAVAILABLE: {
    hint: 'The forgeax server (:18900) is not reachable from this host. Asset import and workbench features will be disabled. Start the server with `bash start.sh` in the forgeax-studio root.',
    expected: 'A running forgeax server reachable at the same-origin /api endpoint.',
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

export async function probeServer(): Promise<ProbeResult> {
  try {
    const r = await apiFetch('/api/workbench/active-slug');
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
    desc: '.glb  .gltf  .fbx',
    hint: 'GLB / GLTF 2.0 / FBX · mesh + material + animation + skeleton',
    accept: '.glb,.gltf,.fbx',
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
  gameRoot: string,
): Promise<{ ok: boolean; error?: string; dest?: string }> {
  // EditSurface runs in the HOST (interface) window — a separate JS realm from the
  // editor iframe where setPathResolver is installed, so the editor-core resolver
  // singleton isn't reachable here. The host injects the game root explicitly (the
  // `gameRoot` prop) — the editor bakes NO on-disk layout convention. Pure libs
  // (editor-core/editor-shared) stay convention-free; the host owns the layout.
  const dest = `${gameRoot}/assets/${file.name}`;
  try {
    const buf = await file.arrayBuffer();
    const data = arrayBufferToBase64(buf);
    const r = await apiFetch('/api/files/upload', {
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

// ── Single-mesh scene-asset → mesh ref ─────────────────────────────────────────
// A whole-GLB `scene` asset normally spawns as an in-session-only `GltfRef`
// (expanded to the GLB's real nodes for ✎ Edit). But `GltfRef` is an editor-only
// component that scene-pack can't persist — so on reopen the entity saves as an
// empty Transform node and the geometry disappears (and ▶ Play never sees it).
//
// When the GLB is a SINGLE-mesh asset (e.g. `bed.glb`), we don't need the whole
// nested-scene machinery: it is equivalent to dropping that one mesh sub-asset.
// Resolve the meta's lone `mesh` sub-asset GUID and route it through the proven
// mesh-spawn path → `Mesh.meshAsset` (+ recovered per-submesh materials), which
// scene-pack round-trips and ▶ Play instantiates (both use registered components
// only). Multi-mesh GLBs (length !== 1) keep the GltfRef path (no regression).
/** GUID of the lone `mesh` sub-asset in a cooked GLB meta, or null when the meta
 *  has zero or several meshes (→ caller keeps the GltfRef whole-scene path). */
function singleMeshGuidFromMeta(metaText: string): string | null {
  try {
    const meta = JSON.parse(metaText) as { subAssets?: Array<{ guid: string; kind: string }> };
    const meshes = (meta.subAssets ?? []).filter((s) => s && s.kind === 'mesh' && typeof s.guid === 'string');
    return meshes.length === 1 ? meshes[0]!.guid : null;
  } catch {
    return null;
  }
}

async function resolveSingleMeshSceneRef(ref: DragAssetRef): Promise<DragAssetRef | null> {
  const metaPath = ref.path;
  // Only the canonical `*.meta.json` sidecar carries the sub-asset table.
  if (typeof metaPath !== 'string' || !/\.meta\.json$/i.test(metaPath)) return null;
  try {
    const r = await apiFetch(`/api/files/raw?path=${encodeURIComponent(metaPath)}`);
    if (!r.ok) return null;
    const guid = singleMeshGuidFromMeta(await r.text());
    if (!guid) return null; // 0 or many meshes → leave to the GltfRef path
    return { type: 'asset', guid, kind: 'mesh', name: ref.name, path: metaPath, payload: ref.payload };
  } catch {
    return null;
  }
}

// ── EditSurface Props ──────────────────────────────────────────────────────────

export interface EditSurfaceProps {
  slug: string;
  /** Host-injected game root (client-relative). The host owns the on-disk layout
   *  convention; EditSurface runs in the HOST window (a different JS realm from the
   *  editor iframe where setPathResolver lives) so it can't reach resolveGamePath —
   *  the host passes the root explicitly. Threaded into the iframe `?gameRoot=` and
   *  used to build upload dests. Standalone: `<slug>`. Studio: its own layout. */
  gameRoot?: string;
  viewportOnly?: boolean;
}

// ── EditSurface Component ──────────────────────────────────────────────────────

export function EditSurface({ slug, gameRoot, viewportOnly }: EditSurfaceProps) {
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
  // GLB import-mode dialog (§4 / D-8): set after a .glb/.gltf upload completes,
  // cleared once the user picks 'whole' (scene/uasset) or 'split' (sub-assets).
  const [glbModePrompt, setGlbModePrompt] = useState<{ dest: string; baseName: string; file: File } | null>(null);
  // Asset drag-to-scene (D-4). The drag ref arrives via the typed editor bus
  // (single-realm), cached in pendingDragAsset for the drop event.
  //   assetDragPending — a CB asset drag is in flight (START..END): show a capture
  //     overlay over the iframe (the iframe would otherwise swallow drag events).
  //   assetDragActive  — the drag is currently over the viewport: highlight it.
  const [assetDragPending, setAssetDragPending] = useState(false);
  const [assetDragActive, setAssetDragActive] = useState(false);
  const pendingDragAsset = useRef<DragAssetRef | null>(null);
  const importFileRef = useRef<HTMLInputElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);

  // ── mount-time probe (D-2) ─────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await probeServer();
      if (cancelled) return;
      setEditorAvailable(result.available);
    })();
    return () => { cancelled = true; };
  }, []);

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
  // Thread the host-injected gameRoot into the iframe so the editor realm's
  // setPathResolver (main.tsx) receives it — the editor bakes no layout convention.
  const voParam = viewportOnly ? '&viewportOnly=1' : '';
  const grParam = gameRoot ? `&gameRoot=${encodeURIComponent(gameRoot)}` : '';
  const src = `/editor/?scene=${encodeURIComponent(loadedSlug)}${voParam}${grParam}`;

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

  // Spawn a single imported sub-asset (mesh / material / texture) as one
  // reference-mode entity. For an imported MESH, recover its original per-submesh
  // glTF materials so a multi-submesh mesh restores its source look instead of a
  // single grey placeholder. Best-effort: any failure leaves the entity as-is.
  // Defined before runGlbImport / spawnAssetRef because BOTH reuse it (a later
  // `const` referenced in their dependency arrays would hit the TDZ at render).
  const spawnMeshOrAssetRef = useCallback(async (ref: DragAssetRef): Promise<void> => {
    const kind = ref.kind ?? '';
    // feat-20260708 M1 path 2 (plan-strategy D-4, AC-02/AC-04): recover the mesh's
    // source glTF per-submesh material GUIDs and let them ride the spawn command's
    // EditorPendingMeshMaterials marker (drag-asset-spawn.ts). This restores the
    // resolver call that was previously reduced to a dead import + a drop-on-spawn
    // TODO: the old code wrote `Material.submeshMaterials` (a component the collapse
    // deleted, so spawnComponentData dropped it -> materials vanished on
    // reopen/Play, AGENTS.md #2 / AC-04). The marker travels with VagSpawnEntity
    // into the iframe editor's gateway, where the SAME drag-spawn resolver
    // (installDragSpawnMeshResolver) turns the GUIDs into MeshRenderer.materials[]
    // handles — the identical marker channel path 1 (spawn-asset-ref.ts) uses.
    // Best-effort: any recovery miss leaves the entity single-material.
    const materialGuids = kind === 'mesh' ? await recoverMeshOriginalMaterialGuids(ref) : undefined;
    const entity = buildSpawnEntityFromDragRef(ref, materialGuids ? { materialGuids } : undefined);
    if (!entity) { console.warn('[editor] unsupported asset kind for scene spawn:', kind); return; }
    sendVagMessage(iframeRef.current?.contentWindow ?? null, VagSpawnEntitySchema, {
      mode: 'reference', entity, name: entity.name,
    });
    sendVagMessage(iframeRef.current?.contentWindow ?? null, VagAssetsChangedSchema, { slug } as any);
  }, [slug]);

  // GLB import after the user picks a mode (D-8). 'whole' declares the sub-assets
  // AND auto-spawns the scene tree (uasset-like); 'split' only declares the
  // individual mesh/material/texture sub-assets so the user can drag them in.
  const runGlbImport = useCallback(async (dest: string, baseName: string, importMode: 'whole' | 'split', file: File) => {
    if (!slug) return;
    try {
      setImportStep('processing');
      setImportMsg(baseName);
      // Cook the canonical meta (external-asset-package incl. the `scene`
      // sub-asset + reimport-stable GUIDs) on the frontend via the engine SSOT
      // (replaces the platform-io process-gltf endpoint which omitted `scene`,
      // so loadMetaAssets rejected the sidecar and nothing showed). The
      // importMode (whole/split) is a pure-frontend spawn concern below — it is
      // deliberately NOT written into the engine meta.
      const metaPath = `${dest}.meta.json`;
      let existing: unknown;
      try {
        const r = await apiFetch(`/api/files/raw?path=${encodeURIComponent(metaPath)}`);
        if (r.ok) existing = JSON.parse(await r.text());
      } catch { /* first import — no existing meta to reuse */ }
      const sourceName = dest.slice(dest.lastIndexOf('/') + 1);
      const cooked = await cookGltfMeta(await file.arrayBuffer(), sourceName, existing);
      if (!cooked.ok || !cooked.metaJson) {
        setImportStep('error');
        setImportMsg(cooked.error ?? 'glTF processing failed');
        return;
      }
      const wrote = await apiFetch('/api/files', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: metaPath, content: cooked.metaJson }),
      });
      if (!wrote.ok) {
        setImportStep('error');
        setImportMsg('Failed to write .meta.json');
        return;
      }

      if (importMode === 'split') {
        // No auto-spawn — just surface the new sub-assets in the Content Browser.
        sendVagMessage(iframeRef.current?.contentWindow ?? null, VagAssetsChangedSchema, { slug } as any);
        setImportStep('done');
        setImportMsg(baseName);
        setTimeout(() => setImportStep(null), 4000);
        return;
      }

      setImportStep('importing');
      // Single-mesh GLB (e.g. bed.glb) → spawn as a persistable `Mesh.meshAsset`
      // entity (survives ✎ Edit reopen + ▶ Play) instead of the in-session-only
      // GltfRef whole-scene tree. Mirrors the drag / Add-to-Scene path
      // (spawnAssetRef → resolveSingleMeshSceneRef); reuses the freshly-cooked
      // meta in-hand (no extra fetch). Multi-mesh GLBs fall through to the
      // import-scene/GltfRef tree spawn below.
      const meshGuid = /\.glb\.meta\.json$/i.test(metaPath) ? singleMeshGuidFromMeta(cooked.metaJson) : null;
      if (meshGuid) {
        await spawnMeshOrAssetRef({ type: 'asset', guid: meshGuid, kind: 'mesh', name: baseName, path: metaPath });
        setImportStep('done');
        setImportMsg(baseName);
        setTimeout(() => setImportStep(null), 4000);
        return;
      }
      // Force 'reference' (NOT 'auto'): a whole import is a single GltfRef resource
      // (uasset-like). 'auto' expands small GLBs into per-node doc entities whose
      // single Material component can't carry a multi-submesh mesh's N materials,
      // tripping the engine's mesh-renderer-material-count-mismatch (materials=1 vs
      // submeshes=N). Mirrors spawnSceneFromGlb (the drag path).
      const sceneRes = await apiFetch('/api/assets/import-scene', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: dest, mode: 'reference' }),
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
  }, [slug, spawnMeshOrAssetRef]);

  // FBX import: browser-side ufbx WASM cook → meta.json (no mode dialog; whole asset).
  const runFbxImport = useCallback(async (dest: string, baseName: string, file: File) => {
    if (!slug) return;
    try {
      setImportStep('processing');
      setImportMsg(baseName);
      const metaPath = `${dest}.meta.json`;
      let existing: unknown;
      try {
        const r = await apiFetch(`/api/files/raw?path=${encodeURIComponent(metaPath)}`);
        if (r.ok) existing = JSON.parse(await r.text());
      } catch { /* first import */ }
      const sourceName = dest.slice(dest.lastIndexOf('/') + 1);
      const cooked = await cookFbxMeta(await file.arrayBuffer(), sourceName, existing);
      if (!cooked.ok || !cooked.metaJson) {
        setImportStep('error');
        setImportMsg(cooked.error ?? 'FBX processing failed');
        return;
      }
      const wrote = await apiFetch('/api/files', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: metaPath, content: cooked.metaJson }),
      });
      if (!wrote.ok) {
        setImportStep('error');
        setImportMsg('Failed to write .fbx.meta.json');
        return;
      }
      sendVagMessage(iframeRef.current?.contentWindow ?? null, VagAssetsChangedSchema, { slug } as any);
      setImportStep('done');
      setImportMsg(`${baseName} (${cooked.summary?.total ?? 0} sub-assets)`);
      setTimeout(() => setImportStep(null), 4000);
    } catch (err) {
      setImportStep('error');
      setImportMsg((err as Error).message ?? String(err));
    }
  }, [slug]);

  const onFileSelected = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file || !slug) return;
    // Fail fast (§5): the host must inject gameRoot before an asset can be placed.
    // The editor bakes no on-disk layout, so with no root there is nowhere to write.
    if (!gameRoot) {
      setImportStep('error');
      setImportMsg('no gameRoot injected — host must supply the game layout');
      return;
    }
    const isGlb = /\.(glb|gltf)$/i.test(file.name);
    const isFbx = /\.fbx$/i.test(file.name);
    const isModel = isGlb || isFbx;
    const baseName = file.name.replace(/\.(glb|gltf|fbx)$/i, '');

    try {
      setImportStep('uploading');
      setImportMsg(file.name);
      const res = await importAssetFile(file, gameRoot);
      if (!res.ok || !res.dest) {
        setImportStep('error');
        setImportMsg(res.error ?? 'Upload failed');
        return;
      }

      if (isFbx) {
        await runFbxImport(res.dest, baseName, file);
        return;
      }

      if (!isModel) {
        sendVagMessage(iframeRef.current?.contentWindow ?? null, VagAssetsChangedSchema, { slug } as any);
        setImportStep('done');
        setImportMsg(file.name);
        setTimeout(() => setImportStep(null), 3000);
        return;
      }

      // GLB/GLTF → pause and ask the user how to import it (§4 / D-8). Keep the
      // File so runGlbImport can cook the meta on the frontend (engine SSOT).
      setImportStep(null);
      setGlbModePrompt({ dest: res.dest, baseName, file });
    } catch (err) {
      setImportStep('error');
      setImportMsg((err as Error).message ?? String(err));
    }
  }, [slug, gameRoot, runFbxImport]);

  // ── Asset drag-to-scene (D-4/D-5) ───────────────────────────────────────────
  // Spawn a whole-GLB asset (mode A) as a single GltfRef instance. Forcing
  // 'reference' (vs 'auto', which expands small GLBs into per-node doc entities)
  // is what makes the whole-resource semantics correct: multi-submesh / multi-
  // material meshes (e.g. bed.glb has 3 submeshes) render via the gltf-runtime
  // cache with their full per-submesh material set. The doc's single Material
  // component can't carry N materials, so the per-node 'full' path trips the
  // engine's mesh-renderer-material-count-mismatch (materials=1 vs submeshes=N).
  const spawnSceneFromGlb = useCallback(async (path: string, name: string): Promise<void> => {
    try {
      const sceneRes = await apiFetch('/api/assets/import-scene', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, mode: 'reference' }),
      });
      const sceneJ = await sceneRes.json() as { mode?: string; entity?: unknown; doc?: unknown; error?: string };
      if (!sceneRes.ok) { console.warn('[editor] drag scene import failed:', sceneJ.error); return; }
      const spawnMode: 'reference' | 'full' = sceneJ.mode === 'full' ? 'full' : 'reference';
      sendVagMessage(iframeRef.current?.contentWindow ?? null, VagSpawnEntitySchema, {
        mode: spawnMode, entity: sceneJ.entity, doc: sceneJ.doc, name,
      });
    } catch (err) {
      console.warn('[editor] drag scene import error:', (err as Error)?.message ?? err);
    }
  }, []);

  const onAssetDragOver = useCallback((e: React.DragEvent) => {
    if (!pendingDragAsset.current) return; // not a Content Browser asset drag
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!assetDragActive) setAssetDragActive(true);
  }, [assetDragActive]);

  const onAssetDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear when leaving the frame itself (not when crossing child elements).
    if (e.currentTarget === e.target) setAssetDragActive(false);
  }, []);

  // Add an asset to the scene — shared by drag-drop (D-4) and the context-menu
  // "Add to Scene" (D-6). Routes whole-GLB (scene) through import-scene, and split
  // sub-assets (mesh/material/texture) through a single reference-mode spawn.
  const spawnAssetRef = useCallback(async (ref: DragAssetRef): Promise<void> => {
    const kind = ref.kind ?? '';
    if (kind === 'scene') {
      // A SINGLE-mesh GLB (e.g. bed.glb) is equivalent to dropping its one mesh
      // sub-asset — spawn it as a persistable `Mesh.meshAsset` entity so it
      // survives ✎ Edit reopen AND ▶ Play (the GltfRef whole-scene reference is
      // editor-only and scene-pack can't persist it → geometry vanishes on
      // reopen). Multi-mesh GLBs fall through to the GltfRef tree spawn below.
      const meshRef = await resolveSingleMeshSceneRef(ref);
      if (meshRef) { await spawnMeshOrAssetRef(meshRef); return; }

      // import-scene needs the GLB's *game-relative* path (e.g.
      // `<gameRoot>/assets/Fox.glb`). The scene asset's packPath is
      // the `.meta.json` sidecar that sits next to the GLB (`Fox.glb.meta.json`),
      // so strip `.meta.json` to recover it. `payload.source` is only the
      // basename (`Fox.glb`) — passing that makes import-scene resolve against
      // the project root and 404 (silent no-op), so it's a last resort.
      const metaPath = ref.path;
      const src = typeof metaPath === 'string' && /\.meta\.json$/i.test(metaPath)
        ? metaPath.replace(/\.meta\.json$/i, '')
        : ((ref.payload?.source as string | undefined) ?? metaPath);
      const name = ref.name ?? 'GLB';
      if (typeof src === 'string' && /\.(glb|gltf|fbx)$/i.test(src)) {
        if (/\.fbx$/i.test(src)) {
          const meshRef = await resolveSingleMeshSceneRef(ref);
          if (meshRef) { await spawnMeshOrAssetRef(meshRef); return; }
          console.warn('[editor] FBX scene spawn needs Phase 2.5 DDC — try Add to Scene on a mesh sub-asset:', metaPath);
          return;
        }
        void spawnSceneFromGlb(src, name);
      }
      else console.warn('[editor] scene asset has no resolvable source — cannot spawn:', metaPath);
      return;
    }
    await spawnMeshOrAssetRef(ref);
  }, [spawnSceneFromGlb, spawnMeshOrAssetRef]);

  const onAssetDrop = useCallback((e: React.DragEvent) => {
    const ref = pendingDragAsset.current;
    if (!ref) return;
    e.preventDefault();
    setAssetDragActive(false);
    setAssetDragPending(false);
    pendingDragAsset.current = null;
    void spawnAssetRef(ref);
  }, [spawnAssetRef]);

  // Content Browser emits drag events on the typed editor bus (same host window
  // since single-realm M2/M4). FORGEAX_ADD_ASSET_TO_SCENE is the context-menu
  // "Add to Scene" path (D-6) — no drag, spawn immediately.
  useEffect(() => {
    const offStart = panelBridge.on('dragAssetStart', (ref) => {
      pendingDragAsset.current = ref;
      setAssetDragPending(true);
    });
    const offEnd = panelBridge.on('dragAssetEnd', () => {
      pendingDragAsset.current = null;
      setAssetDragPending(false);
      setAssetDragActive(false);
    });
    const offScene = panelBridge.on('addAssetToScene', (ref) => {
      void spawnAssetRef(ref);
    });
    return () => { offStart(); offEnd(); offScene(); };
  }, [spawnAssetRef]);

  // ── VAG_* message consumption ──────────────────────────────────────────────
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const expectedSource = iframeRef.current?.contentWindow ?? null;
      if (expectedSource && ev.source !== expectedSource) return;

      const t = (ev.data as { type?: unknown } | null)?.type;
      if (typeof t !== 'string' || !t.startsWith('VAG_')) return;

      // VAG_NETWORK: healthBridge (same host window, single-realm) receives the
      // original message from the engine iframe directly — no forwarding needed.
      if (t === 'VAG_NETWORK') return;

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
          // healthBridge (same host window, single-realm) receives the original
          // message from the engine iframe and feeds store.consoleLog directly.
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
            // While a Content Browser asset drag is in flight, kill the viewport
            // iframe's pointer-events so the native drag is NOT swallowed by the
            // iframe — the `.preview-asset-drop` overlay (a Shell-DOM sibling on
            // top) then actually receives dragover/drop. Mirrors DockShell's
            // proven `html.fx-dock-dragging iframe { pointer-events: none }` fix
            // (a cross-origin iframe otherwise eats the drag before any overlay).
            style={assetDragPending ? { pointerEvents: 'none' } : undefined}
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
        {/* Asset drop capture overlay (D-4). Mounted only while a Content Browser
            asset drag is in flight — sits ON TOP of the iframe (which would
            otherwise swallow the dragover/drop events) to receive the drop. */}
        {assetDragPending && (
          <div
            className={`preview-asset-drop${assetDragActive ? ' preview-asset-drop--active' : ''}`}
            onDragOver={onAssetDragOver}
            onDragLeave={onAssetDragLeave}
            onDrop={onAssetDrop}
          >
            <div className="preview-asset-drop-hint">Drop to add to scene</div>
          </div>
        )}
        {glbModePrompt && (
          <GlbImportModeDialog
            name={glbModePrompt.baseName}
            onCancel={() => setGlbModePrompt(null)}
            onConfirm={(mode) => {
              const p = glbModePrompt;
              setGlbModePrompt(null);
              void runGlbImport(p.dest, p.baseName, mode, p.file);
            }}
          />
        )}
      </div>
    </div>
  );
}

// ── GLB import-mode dialog (§4 / D-8) ──────────────────────────────────────────
// Mirrors UE's Interchange import dialog "Import individual assets" vs "Import as
// scene": 'whole' spawns the GLB as one scene/uasset-like resource, 'split'
// declares each mesh/material/texture as an independent sub-asset.

interface GlbImportModeDialogProps {
  name: string;
  onConfirm: (mode: 'whole' | 'split') => void;
  onCancel: () => void;
}

function GlbImportModeDialog({ name, onConfirm, onCancel }: GlbImportModeDialogProps) {
  const [mode, setMode] = useState<'whole' | 'split'>('whole');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);
  return (
    <div className="glb-import-backdrop" onClick={onCancel}>
      <div className="glb-import-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="glb-import-title">Import “{name}”</div>
        <label className={`glb-import-opt${mode === 'whole' ? ' glb-import-opt--sel' : ''}`}>
          <input type="radio" name="glb-mode" checked={mode === 'whole'} onChange={() => setMode('whole')} />
          <div className="glb-import-opt-body">
            <div className="glb-import-opt-title">Whole resource</div>
            <div className="glb-import-opt-desc">Import as one scene/prefab (uasset-like). Spawns the full node tree.</div>
          </div>
        </label>
        <label className={`glb-import-opt${mode === 'split' ? ' glb-import-opt--sel' : ''}`}>
          <input type="radio" name="glb-mode" checked={mode === 'split'} onChange={() => setMode('split')} />
          <div className="glb-import-opt-body">
            <div className="glb-import-opt-title">Individual sub-assets</div>
            <div className="glb-import-opt-desc">Split into separate mesh / material / texture assets you can drag in one by one.</div>
          </div>
        </label>
        <div className="glb-import-actions">
          <button type="button" className="glb-import-btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="glb-import-btn glb-import-btn--primary" onClick={() => onConfirm(mode)}>Import</button>
        </div>
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