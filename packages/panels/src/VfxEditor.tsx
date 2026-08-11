import { useSyncExternalStore, type ReactElement } from 'react';
import {
  describeVfxGpuEffect,
  isVfxGpuEffectAsset,
  type VfxAuthoringDescriptor,
  type VfxAuthoringNodeDescriptor,
  type VfxAuthoringValue,
} from '@forgeax/engine-vfx';
import { useDocumentAsset } from './AssetEditors';
import { getVfxPreview } from './vfx-preview-slot';
import './vfx-editor.css';

interface SelectionSnapshot { readonly assetGuid: string; readonly nodeId: string }
let selection: SelectionSnapshot | undefined;
const selectionListeners = new Set<() => void>();

function selectNode(assetGuid: string, nodeId: string): void {
  if (selection?.assetGuid === assetGuid && selection.nodeId === nodeId) return;
  selection = Object.freeze({ assetGuid, nodeId });
  for (const listener of selectionListeners) listener();
}

function useSelectedNodeId(assetGuid: string, fallback: string): string {
  return useSyncExternalStore(
    (listener) => { selectionListeners.add(listener); return () => selectionListeners.delete(listener); },
    () => selection?.assetGuid === assetGuid ? selection.nodeId : fallback,
    () => fallback,
  );
}

function useVfxDescriptor(): { readonly assetGuid: string; readonly descriptor?: VfxAuthoringDescriptor; readonly error?: string } {
  const asset = useDocumentAsset();
  if (!asset || asset.kind !== 'particle-effect') return { assetGuid: '', error: 'No VFX document is active.' };
  if (!isVfxGpuEffectAsset(asset.payload)) {
    return { assetGuid: asset.guid, error: 'The cooked GPU VFX program is not resident yet.' };
  }
  return { assetGuid: asset.guid, descriptor: describeVfxGpuEffect(asset.payload) };
}

function findNode(nodes: readonly VfxAuthoringNodeDescriptor[], id: string): VfxAuthoringNodeDescriptor | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const nested = findNode(node.children, id);
    if (nested) return nested;
  }
  return undefined;
}

function renderValue(value: VfxAuthoringValue): string {
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function NodeTree({ assetGuid, nodes, depth = 0 }: {
  readonly assetGuid: string;
  readonly nodes: readonly VfxAuthoringNodeDescriptor[];
  readonly depth?: number;
}): ReactElement {
  const fallback = nodes[0]?.id ?? '';
  const selected = useSelectedNodeId(assetGuid, fallback);
  return <div className="vfx-tree">{nodes.map((node) => (
    <div key={node.id}>
      <button
        type="button"
        className="vfx-tree-row"
        data-active={selected === node.id ? '1' : undefined}
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => selectNode(assetGuid, node.id)}
      >
        <span className={`vfx-role vfx-role-${node.role}`}>{node.role}</span>
        <span>{node.label}</span>
      </button>
      {node.children.length > 0 && <NodeTree assetGuid={assetGuid} nodes={node.children} depth={depth + 1} />}
    </div>
  ))}</div>;
}

function PanelMessage({ children }: { readonly children: string }): ReactElement {
  return <div className="panel vfx-panel"><div className="field muted">{children}</div></div>;
}

export function VfxSystemPanel(): ReactElement {
  const state = useVfxDescriptor();
  if (!state.descriptor) return <PanelMessage>{state.error ?? 'VFX unavailable.'}</PanelMessage>;
  return <div className="panel vfx-panel" data-testid="panel-vfx-system" data-subject-id={state.assetGuid}>
    <div className="vfx-panel-heading">System Outline</div>
    <NodeTree assetGuid={state.assetGuid} nodes={state.descriptor.emitters} />
  </div>;
}

export function VfxDetailsPanel(): ReactElement {
  const state = useVfxDescriptor();
  const fallback = state.descriptor?.emitters[0]?.id ?? '';
  const selected = useSelectedNodeId(state.assetGuid, fallback);
  if (!state.descriptor) return <PanelMessage>{state.error ?? 'VFX unavailable.'}</PanelMessage>;
  const node = findNode(state.descriptor.emitters, selected) ?? state.descriptor.emitters[0];
  return <div className="panel vfx-panel" data-testid="panel-vfx-details" data-subject-id={state.assetGuid}>
    <div className="vfx-panel-heading">{node?.label ?? 'Details'}</div>
    <div className="field muted vfx-source-path">{node?.sourcePath}</div>
    {node?.fields.map((entry) => <div className="vfx-field" key={entry.path} title={entry.path}>
      <span>{entry.label}</span><code>{renderValue(entry.value)}</code>
    </div>)}
  </div>;
}

export function VfxTimelinePanel(): ReactElement {
  const state = useVfxDescriptor();
  if (!state.descriptor) return <PanelMessage>{state.error ?? 'VFX unavailable.'}</PanelMessage>;
  const maxDuration = Math.max(1, ...state.descriptor.timeline.map((track) => track.loopDuration ?? 1));
  return <div className="panel vfx-panel" data-testid="panel-vfx-timeline" data-subject-id={state.assetGuid}>
    <div className="vfx-panel-heading">Emitter Timeline</div>
    {state.descriptor.timeline.map((track) => <div className="vfx-track" key={track.emitterId}>
      <div className="vfx-track-label"><strong>{track.emitterId}</strong><span>{track.rate}/s</span></div>
      <div className="vfx-track-rail">
        <div className="vfx-rate-band" title={`Continuous rate ${track.rate}/s`} />
        {track.bursts.map((burst, index) => <span
          className="vfx-burst"
          key={`${burst.time}:${index}`}
          style={{ left: `${Math.min(100, (burst.time / maxDuration) * 100)}%` }}
          title={`Burst ${burst.count} at ${burst.time}s`}
        />)}
      </div>
      <div className="field muted">loop {track.loopDuration === undefined ? 'continuous' : `${track.loopDuration}s`} · {track.bursts.length} bursts</div>
    </div>)}
  </div>;
}

export function VfxDiagnosticsPanel(): ReactElement {
  const state = useVfxDescriptor();
  if (!state.descriptor) return <PanelMessage>{state.error ?? 'VFX unavailable.'}</PanelMessage>;
  return <div className="panel vfx-panel" data-testid="panel-vfx-diagnostics" data-subject-id={state.assetGuid}>
    <div className="vfx-panel-heading">Capability Truth</div>
    {state.descriptor.capabilities.map((capability) => <div className="vfx-capability" key={capability.id}>
      <span data-state={capability.state}>{capability.state}</span>
      <strong>{capability.id}</strong>
      {capability.reason && <small>{capability.reason}</small>}
    </div>)}
    <div className="vfx-panel-heading vfx-section-heading">Dependencies</div>
    {state.descriptor.dependencies.map((dependency) => <div className="vfx-dependency" key={`${dependency.kind}:${dependency.identity}`}>
      <span>{dependency.kind}</span><code>{dependency.identity}</code>
    </div>)}
  </div>;
}

export function VfxPreviewPanel(): ReactElement {
  const state = useVfxDescriptor();
  const Preview = getVfxPreview();
  return <div className="panel vfx-preview-panel" data-testid="panel-vfx-preview" data-subject-id={state.assetGuid}>
    {!state.descriptor ? <div className="field muted">{state.error}</div> : Preview ? <Preview /> : (
      <div className="field muted">VFX preview viewport is not registered by the host.</div>
    )}
  </div>;
}
