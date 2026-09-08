// UvEditorPanel.tsx — UV Editor dock panel (P1.5).
//
// A read-only 2D展开图 of the active mesh document's UV channels, drawn on a
// Canvas2D. Mirrors UE's Mesh Editor UV view: each triangle's three edges are
// stroked in [0,1]×[0,1] UV space, per-submesh colored, with a unit-tile grid
// border. A channel selector switches between uv / uv1..uv7 when the mesh
// carries multiple UV sets.
//
// Data comes from the same `assets.payload` projection the other mesh panels
// already consume (useDocumentAsset → asset.payload.attributes / indices /
// submeshes), so no engine-side change is needed. The panel is mesh-scoped:
// non-mesh documents show the empty-asset placeholder.

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useDocumentAsset } from './AssetEditors';
import {
  computeUvSegments,
  listUvChannels,
  normalizeUv,
  type UvChannelKey,
  type UvSubmeshRange,
} from './uv-chart';
import './uv-editor.css';

const SUBMESH_COLORS = [
  '#7eb6ff', '#ffb07e', '#9be37a', '#e37ac4', '#7ae3d3', '#e3c47a', '#9a7aff', '#7ad1e3',
];

interface MeshPayloadShape {
  readonly attributes?: Record<string, unknown>;
  readonly indices?: ArrayLike<number>;
  readonly submeshes?: readonly UvSubmeshRange[];
}

export function UvEditorPanel(): ReactElement {
  const asset = useDocumentAsset();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [channel, setChannel] = useState<UvChannelKey>('uv');

  const payload = asset?.kind === 'mesh' ? (asset.payload as unknown as MeshPayloadShape | undefined) : undefined;
  const attributes = payload?.attributes;
  const channels = useMemo(() => listUvChannels(attributes), [attributes]);
  const activeChannel: UvChannelKey = channels.includes(channel) ? (channels[0] ?? 'uv') : channel;

  const segments = useMemo(() => {
    if (attributes === undefined) return [];
    const uv = attributes[activeChannel] as ArrayLike<number> | undefined;
    return computeUvSegments(uv, payload?.indices, payload?.submeshes ?? []);
  }, [attributes, activeChannel, payload?.indices, payload?.submeshes]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    const pad = 16;
    const size = Math.min(width, height) - pad * 2;
    const ox = (width - size) / 2;
    const oy = (height - size) / 2;
    const toX = (u: number): number => ox + normalizeUv(u) * size;
    const toY = (v: number): number => oy + (1 - normalizeUv(v)) * size;

    // Unit-tile border + 0.5 grid.
    ctx.strokeStyle = 'rgba(120, 140, 170, 0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(ox, oy, size, size);
    ctx.beginPath();
    ctx.moveTo(ox + size / 2, oy);
    ctx.lineTo(ox + size / 2, oy + size);
    ctx.moveTo(ox, oy + size / 2);
    ctx.lineTo(ox + size, oy + size / 2);
    ctx.stroke();

    // UV triangle wireframe, per-submesh colored.
    ctx.lineWidth = 1;
    for (const seg of segments) {
      ctx.strokeStyle = SUBMESH_COLORS[seg.submesh % SUBMESH_COLORS.length] ?? '#cdd3dc';
      ctx.beginPath();
      ctx.moveTo(toX(seg.ax), toY(seg.ay));
      ctx.lineTo(toX(seg.bx), toY(seg.by));
      ctx.stroke();
    }
  }, [segments]);

  if (asset?.kind !== 'mesh') {
    return (
      <div className="panel" data-testid="panel-uv-editor" data-subject-id={asset?.guid}>
        <div className="field muted">No asset document is active.</div>
      </div>
    );
  }

  return (
    <div className="panel uv-editor-panel" data-testid="panel-uv-editor" data-subject-id={asset.guid}>
      <div className="uv-editor-toolbar">
        <span className="compname">UV Editor</span>
        {channels.length === 0 ? (
          <span className="field muted">No UV channels in this mesh.</span>
        ) : (
          <label className="uv-editor-channel">
            Channel
            <select
              value={activeChannel}
              onChange={(event) => setChannel(event.target.value as UvChannelKey)}
              data-testid="uv-editor-channel-select"
            >
              {channels.map((key) => (
                <option key={key} value={key}>{key}</option>
              ))}
            </select>
          </label>
        )}
        <span className="field muted uv-editor-count" data-testid="uv-editor-segment-count">
          {segments.length} edges
        </span>
      </div>
      <div className="uv-editor-canvas-host">
        <canvas
          ref={canvasRef}
          width={512}
          height={512}
          data-testid="uv-editor-canvas"
          className="uv-editor-canvas"
        />
      </div>
    </div>
  );
}

export default UvEditorPanel;
