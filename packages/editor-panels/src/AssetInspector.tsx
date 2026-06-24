import { Suspense } from 'react';
import { useAssetSelection } from '@forgeax/editor-shared';
import { PREVIEW_COMPONENTS } from './asset-inspector';

const KIND_BADGE: Record<string, string> = {
  mesh: '◫', texture: '🖼', 'cube-texture': '🧊', sampler: '⚙',
  material: '🎨', scene: '🗺', shader: '📜', skeleton: '🦴',
  skin: '🩻', 'animation-clip': '🎬', audio: '🔊', font: '🔤',
  'render-pipeline': '🔧', tileset: '🧱',
};

export function AssetInspectorPanel() {
  const asset = useAssetSelection();

  if (!asset) {
    return (
      <div className="panel" data-testid="panel-asset-inspector">
        <h3>Asset Inspector</h3>
        <div className="field muted">Select an asset in the Content Browser to inspect it.</div>
      </div>
    );
  }

  const Preview = PREVIEW_COMPONENTS[asset.kind];

  return (
    <div className="panel" data-testid="panel-asset-inspector">
      <h3>
        <span className="asset-inspector-badge">{KIND_BADGE[asset.kind] ?? '📦'}</span>
        {' '}{asset.name}
        <span className="asset-inspector-kind">{asset.kind}</span>
      </h3>
      <div className="field muted" style={{ fontSize: '0.85em', wordBreak: 'break-all' }}>
        {asset.guid}
      </div>
      {Preview ? (
        <Suspense fallback={<div className="field muted">Loading preview…</div>}>
          <Preview payload={asset.payload} />
        </Suspense>
      ) : (
        <div className="field muted">No preview available for kind "{asset.kind}".</div>
      )}
    </div>
  );
}
