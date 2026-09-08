// @forgeax/editor-edit-runtime — Mesh Preview panel runtime (STD-01/T1.2).
//
// This component is intentionally a thin UI shell. PreviewWorldService owns
// canvas/createApp/World/Viewport and keeps the preview outside the authored
// editor world.

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import {
  queryViewportRuntimeProjection,
  subscribeAssetsChanged,
  subscribeViewportRuntimeClient,
  useActiveEditorAsset,
} from '@forgeax/editor-core';
import {
  PreviewWorldService,
  type MeshPreviewSnapshot,
} from '../preview-world/preview-world-service';
import type { SkeletonTreeNode } from '../preview-world/skeleton-tree';
import {
  setMeshPreviewToolbarHandlers,
  setMeshPreviewToolbarState,
  useMeshPreviewToolbarRegistration,
} from './mesh-preview-toolbar';
import './mesh-preview.css';

const BOOTING: MeshPreviewSnapshot = { status: 'booting' };

export function MeshPreviewViewport(): ReactElement {
  const asset = useActiveEditorAsset();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const serviceRef = useRef<PreviewWorldService | null>(null);
  const [snapshot, setSnapshot] = useState<MeshPreviewSnapshot>(BOOTING);
  const [catalogRevision, setCatalogRevision] = useState<string | undefined>();
  const [publicationGeneration, setPublicationGeneration] = useState(0);
  const [boundsVisible, setBoundsVisible] = useState(true);
  const [skeletonVisible, setSkeletonVisible] = useState(true);
  const [treeVisible, setTreeVisible] = useState(true);

  const refreshRevision = useCallback(() => {
    if (asset?.kind !== 'mesh') {
      setCatalogRevision(undefined);
      return;
    }
    void queryViewportRuntimeProjection<{ readonly entries?: readonly {
      readonly guid: string;
      readonly revision?: unknown;
      readonly sourceOverrides?: unknown;
      readonly refs?: unknown;
      readonly packageUrl?: unknown;
    }[] }>({
      kind: 'assets.catalog',
    }).then((projection) => {
      if (projection.status !== 'ready') return;
      const row = projection.value.entries?.find((entry) => entry.guid.toLowerCase() === asset.guid.toLowerCase());
      const revision = row?.revision;
      const explicit = typeof revision === 'string'
        ? revision
        : revision && typeof revision === 'object' && 'digest' in revision
          ? String((revision as { readonly digest: unknown }).digest)
          : undefined;
      const text = row === undefined
        ? undefined
        : `catalog-projection:${JSON.stringify({
            revision: explicit,
            sourceOverrides: row.sourceOverrides,
            refs: row.refs,
            packageUrl: row.packageUrl,
          })}`;
      setCatalogRevision(text);
    }).catch(() => {});
  }, [asset?.guid, asset?.kind]);

  useEffect(() => {
    refreshRevision();
    const offAssets = subscribeAssetsChanged((event) => {
      if (event.mutation?.kind === 'changed'
        && asset?.kind === 'mesh'
        && event.mutation.guid.toLowerCase() === asset.guid.toLowerCase()) {
        setPublicationGeneration((generation) => generation + 1);
      }
      refreshRevision();
    });
    const offRuntime = subscribeViewportRuntimeClient(refreshRevision);
    return () => { offAssets(); offRuntime(); };
  }, [refreshRevision]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
           const service = PreviewWorldService.create('mesh');
    serviceRef.current = service;
    void service.mount(host, setSnapshot);
    return () => {
      service.dispose();
      if (serviceRef.current === service) serviceRef.current = null;
    };
  }, []);

  useEffect(() => {
    const revision = catalogRevision === undefined
      ? `publication:${publicationGeneration}`
      : `${catalogRevision}|publication:${publicationGeneration}`;
    void serviceRef.current?.replaceSubject(
      asset?.kind === 'mesh' || asset?.kind === 'scene' ? asset : null,
      revision,
    );
  }, [asset?.guid, asset?.kind, catalogRevision, publicationGeneration]);

  useEffect(() => {
    serviceRef.current?.setBoundsOverlayVisible(boundsVisible);
  }, [boundsVisible]);

  useEffect(() => {
    serviceRef.current?.setSkeletonOverlayVisible(skeletonVisible);
  }, [skeletonVisible]);

  // ── Header toolbar wiring ──────────────────────────────────────────────────
  // Frame / reset / bounds / skeleton / tree used to be an in-canvas bar; they
  // now live in the panel header as a single self-registered `control`. This
  // component mirrors its UI state into the toolbar's module store and hands the
  // store the imperative callbacks — all feature-internal (mirrors the material
  // preview toolbar wiring).
  useEffect(() => {
    setMeshPreviewToolbarState({
      ready: snapshot.status === 'ready',
      boundsVisible,
      skeletonVisible,
      treeVisible,
      hasSkeletonTree: snapshot.skeletonTree !== undefined,
    });
  }, [snapshot.status, snapshot.skeletonTree, boundsVisible, skeletonVisible, treeVisible]);

  useEffect(() => {
    setMeshPreviewToolbarHandlers({
      frameAll: () => serviceRef.current?.frameCurrentSubject(),
      resetCamera: () => serviceRef.current?.resetCamera(),
      toggleBounds: () => setBoundsVisible((value) => !value),
      toggleSkeleton: () => setSkeletonVisible((value) => !value),
      toggleTree: () => setTreeVisible((value) => !value),
    });
    return () => setMeshPreviewToolbarHandlers(null);
  }, []);

  useMeshPreviewToolbarRegistration('mesh-preview');

  const statusText = snapshot.status === 'booting'
    ? 'Booting preview…'
    : snapshot.status === 'loading'
      ? 'Loading Mesh…'
      : snapshot.status === 'failed'
        ? `Preview unavailable${snapshot.error ? `: ${snapshot.error}` : ''}`
        : snapshot.status === 'empty'
          ? 'Select a Mesh asset to preview.'
          : null;

  return (
    <div
      className="mesh-preview-viewport"
      data-testid="mesh-preview-viewport"
      data-preview-catalog-revision={catalogRevision}
      data-preview-operation-id={snapshot.previewOperationId}
      data-preview-source={snapshot.previewSource}
      data-preview-subject={snapshot.assetGuid}
    >
      {/* Status probe kept in the body for the e2e contract; the visual status
          is the canvas overlay below, and the toolbar now lives in the header. */}
      <span
        className="mesh-preview-status-probe"
        data-testid="mesh-preview-status"
        aria-hidden="true"
      >
        {snapshot.status}
      </span>
      <div className="mesh-preview-canvas-host" ref={hostRef}>
        {statusText !== null && (
          <div className="field muted mesh-preview-status" data-testid="mesh-preview-message">
            {statusText}
          </div>
        )}
      </div>
      {treeVisible && snapshot.skeletonTree !== undefined && snapshot.skeletonTree.length > 0 && (
        <div
          className="mesh-preview-skeleton-tree"
          data-testid="mesh-preview-skeleton-tree"
        >
          <div className="mesh-preview-skeleton-tree-header">Skeleton Tree</div>
          <div className="mesh-preview-skeleton-tree-body">
            {snapshot.skeletonTree.map((node) => (
              <SkeletonTreeRow key={node.path} node={node} depth={0} />
            ))}
          </div>
        </div>
      )}
      {snapshot.status === 'ready' && snapshot.bounds && (
        <div
          className="mesh-preview-footer"
          data-testid="mesh-preview-bounds"
          data-preview-material-guids={(snapshot.materialDefaultGuids ?? []).join(',')}
        >
          Bounds radius {snapshot.bounds.radius.toFixed(3)}
        </div>
      )}
    </div>
  );
}

export default MeshPreviewViewport;

function SkeletonTreeRow({ node, depth }: { readonly node: SkeletonTreeNode; readonly depth: number }): ReactElement {
  return (
    <div className="mesh-preview-skeleton-tree-row" style={{ paddingLeft: `${depth * 14}px` }}>
      <span className="mesh-preview-skeleton-tree-name" title={node.path}>{node.name}</span>
      {node.children.length > 0 && (
        <div>
          {node.children.map((child) => (
            <SkeletonTreeRow key={child.path} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
