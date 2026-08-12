// @forgeax/editor-edit-runtime — Mesh Preview panel runtime (STD-01/T1.2).
//
// This component is intentionally a thin UI shell. PreviewWorldService owns
// canvas/createApp/World/Viewport and keeps the preview outside the authored
// editor world.

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useActiveEditorAsset } from '@forgeax/editor-core';
import {
  PreviewWorldService,
  type MeshPreviewSnapshot,
} from '../preview-world/preview-world-service';
import './mesh-preview.css';

const BOOTING: MeshPreviewSnapshot = { status: 'booting' };

export function MeshPreviewViewport(): ReactElement {
  const asset = useActiveEditorAsset();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const serviceRef = useRef<PreviewWorldService | null>(null);
  const [snapshot, setSnapshot] = useState<MeshPreviewSnapshot>(BOOTING);

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
    void serviceRef.current?.replaceSubject(asset?.kind === 'mesh' ? asset : null);
  }, [asset?.guid, asset?.kind]);

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
    <div className="mesh-preview-viewport" data-testid="mesh-preview-viewport">
      <div className="mesh-preview-toolbar">
        <button
          type="button"
          data-testid="mesh-preview-frame"
          onClick={() => serviceRef.current?.frameCurrentSubject()}
          disabled={snapshot.status !== 'ready'}
        >
          Frame All
        </button>
        <button
          type="button"
          data-testid="mesh-preview-reset"
          onClick={() => serviceRef.current?.resetCamera()}
        >
          Reset Camera
        </button>
        <span className="mesh-preview-status-label" data-testid="mesh-preview-status">
          {snapshot.status}
        </span>
      </div>
      <div className="mesh-preview-canvas-host" ref={hostRef}>
        {statusText !== null && (
          <div className="field muted mesh-preview-status" data-testid="mesh-preview-message">
            {statusText}
          </div>
        )}
      </div>
      {snapshot.status === 'ready' && snapshot.bounds && (
        <div className="mesh-preview-footer" data-testid="mesh-preview-bounds">
          Bounds radius {snapshot.bounds.radius.toFixed(3)}
        </div>
      )}
    </div>
  );
}

export default MeshPreviewViewport;
