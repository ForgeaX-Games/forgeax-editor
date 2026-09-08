// @forgeax/editor-edit-runtime — Texture preview panel runtime (STD-01).
//
// Thin UI shell. TexturePreviewWorldService owns canvas/createApp/world lifecycle.

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import {
  queryViewportRuntimeProjection,
  subscribeAssetsChanged,
  subscribeViewportRuntimeClient,
  useActiveEditorAsset,
} from '@forgeax/editor-core';
import {
  TexturePreviewWorldService,
  type TexturePreviewSnapshot,
} from '../preview-world/texture-preview-world-service';
import {
  DEFAULT_TEXTURE_PREVIEW_VIEW_STATE,
  type TexturePreviewViewState,
} from '../preview-world/texture-preview-view-state';
import {
  setTexturePreviewToolbarHandlers,
  setTexturePreviewToolbarState,
  useTexturePreviewToolbarRegistration,
} from './texture-preview-toolbar';
import './texture-preview.css';

const BOOTING: TexturePreviewSnapshot = { status: 'booting' };

export function TexturePreviewViewport(): ReactElement {
  const asset = useActiveEditorAsset();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const serviceRef = useRef<TexturePreviewWorldService | null>(null);
  const [snapshot, setSnapshot] = useState<TexturePreviewSnapshot>(BOOTING);
  const [viewState, setViewState] = useState<TexturePreviewViewState>(DEFAULT_TEXTURE_PREVIEW_VIEW_STATE);
  const [catalogRevision, setCatalogRevision] = useState<string | undefined>();
  const [publicationGeneration, setPublicationGeneration] = useState(0);

  const refreshRevision = useCallback(() => {
    if (asset?.kind !== 'texture' && asset?.kind !== 'image') {
      setCatalogRevision(undefined);
      return;
    }
    void queryViewportRuntimeProjection<{ readonly entries?: readonly {
      readonly guid: string;
      readonly revision?: unknown;
    }[] }>({ kind: 'assets.catalog' }).then((projection) => {
      if (projection.status !== 'ready' || asset === null) return;
      const row = projection.value.entries?.find((entry) => entry.guid.toLowerCase() === asset.guid.toLowerCase());
      const revision = row?.revision;
      const explicit = typeof revision === 'string'
        ? revision
        : revision && typeof revision === 'object' && 'digest' in revision
          ? String((revision as { readonly digest: unknown }).digest)
          : undefined;
      setCatalogRevision(explicit === undefined ? undefined : `catalog:${explicit}`);
    }).catch(() => {});
  }, [asset?.guid, asset?.kind]);

  useEffect(() => {
    refreshRevision();
    const offAssets = subscribeAssetsChanged((event) => {
      if (event.mutation?.kind === 'changed'
        && asset !== null
        && (asset.kind === 'texture' || asset.kind === 'image')
        && event.mutation.guid.toLowerCase() === asset.guid.toLowerCase()) {
        setPublicationGeneration((generation) => generation + 1);
      }
      refreshRevision();
    });
    const offRuntime = subscribeViewportRuntimeClient(refreshRevision);
    return () => { offAssets(); offRuntime(); };
  }, [refreshRevision, asset?.guid, asset?.kind]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const service = TexturePreviewWorldService.create();
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
      asset?.kind === 'texture' || asset?.kind === 'image' ? asset : null,
      revision,
    );
  }, [asset?.guid, asset?.kind, catalogRevision, publicationGeneration]);

  useEffect(() => {
    serviceRef.current?.setViewState(viewState);
  }, [viewState]);

  useEffect(() => {
    const mipCount = Math.max(1, Number(asset?.payload?.mipLevelCount ?? (asset?.payload?.mipmap ? 1 : 1)));
    setTexturePreviewToolbarState({
      ...viewState,
      ready: snapshot.status === 'ready',
      mipCount,
    });
  }, [snapshot.status, viewState, asset?.payload]);

  useEffect(() => {
    setTexturePreviewToolbarHandlers({
      setViewState: (patch) => setViewState((current) => ({ ...current, ...patch })),
      resetView: () => serviceRef.current?.resetView(),
    });
    return () => setTexturePreviewToolbarHandlers(null);
  }, []);

  useTexturePreviewToolbarRegistration('texture-preview');

  const statusText = snapshot.status === 'booting'
    ? 'Booting preview…'
    : snapshot.status === 'loading'
      ? 'Loading texture…'
      : snapshot.status === 'failed'
        ? `Preview unavailable${snapshot.error ? `: ${snapshot.error}` : ''}`
        : snapshot.status === 'empty'
          ? 'Select a Texture asset to preview.'
          : null;

  return (
    <div
      className={`texture-preview-viewport${viewState.checkerboardVisible ? ' texture-preview-checkerboard' : ''}`}
      data-testid="texture-preview-viewport"
      data-preview-operation-id={snapshot.previewOperationId}
      data-preview-source={snapshot.previewSource}
      data-preview-subject={snapshot.assetGuid}
    >
      <span className="texture-preview-status-probe" data-testid="texture-preview-status" aria-hidden="true">
        {snapshot.status}
      </span>
      <div className="texture-preview-canvas-host" ref={hostRef}>
        {statusText !== null && (
          <div className="field muted texture-preview-status" data-testid="texture-preview-message">
            {statusText}
          </div>
        )}
      </div>
      {snapshot.status === 'ready' && snapshot.width !== undefined && snapshot.height !== undefined && (
        <div className="texture-preview-footer" data-testid="texture-preview-footer">
          {snapshot.width} × {snapshot.height}
          {snapshot.format ? ` · ${snapshot.format}` : ''}
          {viewState.channel !== 'rgb' ? ` · channel ${viewState.channel.toUpperCase()}` : ''}
        </div>
      )}
    </div>
  );
}

export default TexturePreviewViewport;
