// MaterialPreviewViewport — isolated material 3D preview (M5/C1–C5, generalized
// to base materials for the Material page).
//
// Own canvas + createApp world. Value source depends on the active asset kind:
// MI staging → resolveOverrides, or base material → live catalog resolve +
// transient drag overlay; both mutate the preview MaterialAsset.values in
// place. Orbit-only interaction (no pick/gizmo).

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { createApp, type App } from '@forgeax/engine-app';
import {
  clearMaterialPreviewParams,
  createEngineFacade,
  ensureMaterialChainCataloged,
  getMaterialPreviewParams,
  getMiStaging,
  materialCatalogLookup,
  panelBridge,
  resolveOverrides,
  subscribeMaterialPreviewParams,
  subscribeMiStaging,
  useActiveEditorAsset,
  gateway,
} from '@forgeax/editor-core';
import { useTranslation } from '@forgeax/editor-core/i18n';
import {
  assembleMaterialPreviewWorld,
  type MaterialPreviewAssembly,
  type PreviewMeshKind,
} from './assemble-material-preview-world';
import { createViewport, type Viewport } from './viewport';

const MESH_KINDS: readonly PreviewMeshKind[] = ['sphere', 'cube', 'plane', 'custom'];

/** Same base-aware manifest URL the main viewport injects. Without it the
 *  renderer falls back to a root-absolute `/shaders/manifest.json`, which 404s
 *  whenever the host serves the editor under a non-root base — a preview world
 *  with no compiled shaders draws nothing. */
const PREVIEW_BUNDLER_OPTIONS = {
  shaderManifestUrl: `${(import.meta.env.BASE_URL ?? '/').replace(/\/$/, '')}/shaders/manifest.json`,
};

export function MaterialPreviewViewport(): ReactElement {
  const { t } = useTranslation();
  const asset = useActiveEditorAsset();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const assemblyRef = useRef<MaterialPreviewAssembly | null>(null);
  const [meshKind, setMeshKind] = useState<PreviewMeshKind>('sphere');
  const [status, setStatus] = useState<'booting' | 'ready' | 'error'>('booting');
  const [errorHint, setErrorHint] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let app: App | null = null;
    let viewport: Viewport | null = null;
    let facade: ReturnType<typeof createEngineFacade> | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const canvas = document.createElement('canvas');
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.style.touchAction = 'none';
    host.appendChild(canvas);

    void (async () => {
      const created = await createApp(
        canvas,
        { pointerLockAllowed: () => false },
        PREVIEW_BUNDLER_OPTIONS,
      );
      if (cancelled) {
        if (created.ok) created.value.stop();
        return;
      }
      if (!created.ok) {
        // Headless / no-GPU fallback for CI.
        try {
          const rhiNull = await import('@forgeax/engine-rhi-null');
          const retry = await createApp(
            canvas,
            { pointerLockAllowed: () => false, rhi: rhiNull.rhi as never },
            PREVIEW_BUNDLER_OPTIONS,
          );
          if (!retry.ok) {
            setStatus('error');
            setErrorHint(String((retry.error as { message?: string })?.message ?? retry.error));
            return;
          }
          app = retry.value;
        } catch (error) {
          setStatus('error');
          setErrorHint(error instanceof Error ? error.message : String(error));
          return;
        }
      } else {
        app = created.value;
      }
      if (!app || cancelled) return;

      facade = createEngineFacade(app.world as never);
      const assembly = assembleMaterialPreviewWorld(facade);
      assemblyRef.current = assembly;

      viewport = createViewport({
        canvas,
        engine: facade,
        editorEngine: facade,
        camera: assembly.camera,
        initialOrbit: { target: [0, 1, 0], dist: 3, yaw: 0.55, pitch: -0.35 },
        interaction: 'orbit-only',
      });

      const syncSize = () => {
        const rect = host.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(1, Math.floor(rect.width * dpr));
        const h = Math.max(1, Math.floor(rect.height * dpr));
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
          viewport?.refresh();
        }
      };
      syncSize();
      resizeObserver = new ResizeObserver(syncSize);
      resizeObserver.observe(host);

      app.start();
      setStatus('ready');
    })();

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      try { viewport?.dispose(); } catch { /* already disposed */ }
      try { app?.stop(); } catch { /* already stopped */ }
      assemblyRef.current = null;
      if (canvas.parentElement === host) host.removeChild(canvas);
    };
  }, []);

  // Material values → preview material hot refresh. Gated on `status` so the
  // first apply cannot land before assembleMaterialPreviewWorld created the
  // material: the boot is async, and staging opens (and notifies) while it is
  // still in flight, so a subscription-only apply would leave the preview on
  // its unresolved baseline until the user next touched a field.
  //
  // Two value sources by asset kind:
  //   - material-instance: the MI staging buffer (resolveOverrides over the
  //     parent chain), re-applied on every staging notify;
  //   - material: the live catalog payload resolved over its parent chain,
  //     re-applied on `assetsChanged` (the updateMaterialParams applier
  //     invalidates the envelope post-write, so the chain is re-warmed before
  //     resolving), overlaid with the transient drag channel
  //     (material-preview-staging) so slider drags repaint without a commit.
  useEffect(() => {
    if (status !== 'ready') return;
    let cancelled = false;

    const applyMi = () => {
      const assembly = assemblyRef.current;
      if (!assembly || !asset || asset.kind !== 'material-instance') return;
      const staging = getMiStaging(asset.guid)?.staging;
      if (!staging) return;
      assembly.applyResolvedValues(resolveOverrides(staging, materialCatalogLookup(gateway.doc.registry)));
    };

    const applyMaterial = () => {
      const assembly = assemblyRef.current;
      if (!assembly || !asset || asset.kind !== 'material') return;
      assembly.applyResolvedValues({
        ...resolveOverrides(asset.guid, materialCatalogLookup(gateway.doc.registry)),
        ...getMaterialPreviewParams(asset.guid),
      });
    };

    if (asset?.kind === 'material-instance') {
      applyMi();
      // The parent is only in registry.assetCatalog once loadByGuid ran for
      // it — warm the whole chain, then re-resolve so inherited values show.
      const staging = getMiStaging(asset.guid)?.staging;
      if (staging) {
        void ensureMaterialChainCataloged(gateway.doc.registry, staging).then(() => {
          if (!cancelled) applyMi();
        });
      }
      const unsubscribe = subscribeMiStaging(applyMi);
      return () => { cancelled = true; unsubscribe(); };
    }

    if (asset?.kind === 'material') {
      const warmAndApply = () => {
        void ensureMaterialChainCataloged(gateway.doc.registry, asset.guid).then(() => {
          if (cancelled) return;
          // Post-commit the catalog is the SSOT again — drop the transient
          // drag overlay so it cannot mask the resolved values. (Clearing
          // notifies the staging subscriber, which simply re-applies.)
          clearMaterialPreviewParams(asset.guid);
          applyMaterial();
        });
      };
      warmAndApply();
      const offAssets = panelBridge.on('assetsChanged', warmAndApply);
      const offStaged = subscribeMaterialPreviewParams((guid) => {
        if (guid === asset.guid.toLowerCase()) applyMaterial();
      });
      return () => { cancelled = true; offAssets(); offStaged(); };
    }
  }, [asset?.guid, asset?.kind, status]);

  useEffect(() => {
    assemblyRef.current?.setPreviewMesh(meshKind);
  }, [meshKind]);

  return (
    <div className="mi-preview-viewport" data-testid="mi-preview-viewport">
      <div className="mi-preview-toolbar" data-testid="mi-preview-mesh-switcher">
        {MESH_KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            data-active={meshKind === kind ? '1' : undefined}
            data-testid={`mi-preview-mesh-${kind}`}
            disabled={kind === 'custom'}
            title={kind === 'custom' ? t('editor.materialInstance.previewMesh.customSoon') : undefined}
            onClick={() => setMeshKind(kind)}
          >
            {t(`editor.materialInstance.previewMesh.${kind}`)}
          </button>
        ))}
      </div>
      <div className="mi-preview-canvas-host" ref={hostRef}>
        {status === 'booting' && (
          <div className="field muted mi-preview-status">Booting preview…</div>
        )}
        {status === 'error' && (
          <div className="field muted mi-preview-status" data-testid="mi-preview-error">
            Preview unavailable{errorHint ? `: ${errorHint}` : ''}
          </div>
        )}
      </div>
    </div>
  );
}

export default MaterialPreviewViewport;
