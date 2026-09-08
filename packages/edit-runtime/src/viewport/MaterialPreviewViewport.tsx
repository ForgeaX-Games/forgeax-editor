// MaterialPreviewViewport — isolated material 3D preview (M5/C1–C5, generalized
// to base materials for the Material page).
//
// Own canvas + createApp world. Value source depends on the active asset kind:
// MI staging → resolveOverrides, or base material → live catalog resolve +
// transient drag overlay; both mutate the preview MaterialAsset.values in
// place. Orbit-only interaction (no pick/gizmo).

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { createApp, type App } from '@forgeax/engine-app';
import { createMaterialPreviewPrimitive, materialBindingFromPayload, previewSnapshot } from '@forgeax/engine-preview';
import {
  clearMaterialPreviewParams,
  createEngineFacade,
  ensureMaterialChainCataloged,
  getMiStaging,
  isMaterialStagingDirty,
  materialCatalogLookup,
  panelBridge,
  resolveMaterialPreviewDisplayValues,
  resolveOverrides,
  subscribeMaterialPreviewParams,
  subscribeMaterialStaging,
  subscribeMiStaging,
  useActiveEditorAsset,
  gateway,
  type CameraProjection,
} from '@forgeax/editor-core';
import type { CameraViewPreset } from './viewport-camera';
import { AssetPicker, loadDocumentAssetPayload } from '@forgeax/editor-panels';
import {
  assembleMaterialPreviewWorld,
  type MaterialPreviewAssembly,
  type PreviewMeshKind,
} from './assemble-material-preview-world';
import { createViewport, type Viewport } from './viewport';
import { createPreviewBundlerOptions } from './preview-bundler-options';
import {
  setMaterialPreviewToolbarHandlers,
  setMaterialPreviewToolbarState,
  useMaterialPreviewToolbarRegistration,
} from './material-preview-toolbar';

export function MaterialPreviewViewport(): ReactElement {
  const asset = useActiveEditorAsset();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const assemblyRef = useRef<MaterialPreviewAssembly | null>(null);
  const viewportRef = useRef<Viewport | null>(null);
  const [meshKind, setMeshKind] = useState<PreviewMeshKind>('sphere');
  const [customMeshGuid, setCustomMeshGuid] = useState<string | null>(null);
  const [customMeshName, setCustomMeshName] = useState<string | null>(null);
  const [isPickingMesh, setIsPickingMesh] = useState(false);
  const [cameraView, setCameraView] = useState<CameraViewPreset>('perspective');
  const [fovDegrees, setFovDegrees] = useState(60);
  const [status, setStatus] = useState<'booting' | 'ready' | 'error'>('booting');
  const [errorHint, setErrorHint] = useState<string | null>(null);
  const [previewIdentity, setPreviewIdentity] = useState<{ operationId: string; source: string; subjectGuid: string }>();

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
      const previewBundlerOptions = await createPreviewBundlerOptions();
      const created = await createApp(
        canvas,
        { pointerLockAllowed: () => false },
        previewBundlerOptions,
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
            previewBundlerOptions,
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
        interaction: 'preview',
      });
      viewportRef.current = viewport;

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
      viewportRef.current = null;
      if (canvas.parentElement === host) host.removeChild(canvas);
    };
  }, []);

  // Keyboard navigation for view shortcuts
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.altKey) {
      if (e.key === 'g' || e.key === 'G') {
        e.preventDefault();
        setCameraView('perspective');
        viewportRef.current?.setCameraView?.('perspective');
      } else if (e.key === 'j' || e.key === 'J') {
        e.preventDefault();
        setCameraView('top');
        viewportRef.current?.setCameraView?.('top');
      } else if (e.key === 'h' || e.key === 'H') {
        e.preventDefault();
        setCameraView('front');
        viewportRef.current?.setCameraView?.('front');
      } else if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        setCameraView('left');
        viewportRef.current?.setCameraView?.('left');
      }
    } else if (e.key === 'f' || e.key === 'F') {
      viewportRef.current?.resetCamera();
    }
  }, []);

  // Material values → preview material hot refresh.
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
      const lookup = materialCatalogLookup(gateway.doc.registry);
      const values = resolveMaterialPreviewDisplayValues(asset.guid, lookup);
      assembly.applyResolvedValues(values);
      if (!isMaterialStagingDirty(asset.guid)) {
        clearMaterialPreviewParams(asset.guid);
      }
    };

    if (asset?.kind === 'material-instance') {
      applyMi();
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
      applyMaterial();
      const warmAndApply = () => {
        applyMaterial();
        void ensureMaterialChainCataloged(gateway.doc.registry, asset.guid).then(() => {
          if (cancelled) return;
          applyMaterial();
          void loadDocumentAssetPayload(asset.guid).then((payload) => {
            if (cancelled || !payload || typeof payload !== 'object' || (payload as { readonly kind?: unknown }).kind !== 'material') return;
            const binding = materialBindingFromPayload(asset.guid, payload as never);
            if (binding) {
              const primitive = createMaterialPreviewPrimitive({
                subjectGuid: asset.guid,
                snapshot: previewSnapshot(asset.guid),
                binding,
              });
              assemblyRef.current?.setEnginePrimitive?.(primitive);
              setPreviewIdentity({ operationId: primitive.operationId, source: primitive.source, subjectGuid: primitive.subject.guid });
            }
          });
        });
      };
      warmAndApply();
      const offAssets = panelBridge.on('assetsChanged', warmAndApply);
      const offStaged = subscribeMaterialPreviewParams((guid) => {
        if (guid === asset.guid.toLowerCase()) applyMaterial();
      });
      const offStaging = subscribeMaterialStaging(() => {
        applyMaterial();
      });
      return () => { cancelled = true; offAssets(); offStaged(); offStaging(); };
    }
  }, [asset?.guid, asset?.kind, status]);

  const handleSelectView = useCallback((view: CameraViewPreset) => {
    setCameraView(view);
    viewportRef.current?.setCameraView?.(view);
  }, []);

  const handleFovChange = useCallback((degrees: number) => {
    setFovDegrees(degrees);
    const radians = (degrees * Math.PI) / 180;
    viewportRef.current?.setFov?.(radians);
  }, []);

  const handleSelectMeshKind = useCallback((kind: PreviewMeshKind) => {
    if (kind === 'custom') {
      setIsPickingMesh(true);
      return;
    }
    setMeshKind(kind);
    const bounds = assemblyRef.current?.setPreviewMesh(kind);
    if (bounds && viewportRef.current) {
      viewportRef.current.frameBounds(bounds);
    }
  }, []);

  const handlePickCustomMesh = useCallback((guid: string) => {
    setIsPickingMesh(false);
    setCustomMeshGuid(guid);
    const entry = gateway.assetCatalog().find((e) => e.guid === guid);
    const name = entry?.name || guid.slice(0, 8);
    setCustomMeshName(name);
    setMeshKind('custom');
    void (async () => {
      const payload = await loadDocumentAssetPayload(guid);
      if (payload && assemblyRef.current) {
        const bounds = assemblyRef.current.setPreviewMesh('custom', payload);
        viewportRef.current?.frameBounds(bounds);
      }
    })();
  }, []);

  const handleResetCamera = useCallback(() => {
    viewportRef.current?.resetCamera();
  }, []);

  // ── Header toolbar wiring ──────────────────────────────────────────────────
  // The primitive switcher / camera view / reset used to be an in-canvas bar;
  // they now live in the panel header as a single self-registered `control`.
  // This component derives its own panel id (mat-preview vs mi-preview) from the
  // active asset kind, mirrors its UI state into the toolbar's module store and
  // hands the store the imperative callbacks — all feature-internal.
  const panelId: string | null =
    asset?.kind === 'material' ? 'mat-preview'
    : asset?.kind === 'material-instance' ? 'mi-preview'
    : null;

  useEffect(() => {
    setMaterialPreviewToolbarState({ meshKind, cameraView, fovDegrees, customMeshName });
  }, [meshKind, cameraView, fovDegrees, customMeshName]);

  useEffect(() => {
    setMaterialPreviewToolbarHandlers({
      selectMeshKind: handleSelectMeshKind,
      selectCameraView: handleSelectView,
      setFov: handleFovChange,
      resetCamera: handleResetCamera,
    });
    return () => setMaterialPreviewToolbarHandlers(null);
  }, [handleSelectMeshKind, handleSelectView, handleFovChange, handleResetCamera]);

  useMaterialPreviewToolbarRegistration(panelId);

  return (
    <div
      className="mi-preview-viewport"
      data-testid="mi-preview-viewport"
      data-preview-operation-id={previewIdentity?.operationId}
      data-preview-source={previewIdentity?.source}
      data-preview-subject={previewIdentity?.subjectGuid}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
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

      {isPickingMesh && (
        <AssetPicker
          assetType="MeshAsset"
          currentGuid={customMeshGuid}
          onPick={handlePickCustomMesh}
          onClear={() => {
            setIsPickingMesh(false);
            setCustomMeshGuid(null);
            setCustomMeshName(null);
            handleSelectMeshKind('sphere');
          }}
          onClose={() => setIsPickingMesh(false)}
        />
      )}
    </div>
  );
}

export default MaterialPreviewViewport;
