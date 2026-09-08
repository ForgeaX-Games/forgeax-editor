import { useState, useSyncExternalStore, type ComponentType, type ReactElement } from 'react';
import {
  Braces,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  FileCode2,
  Layers,
  Radio,
  SlidersHorizontal,
  Sparkles,
  Zap,
} from 'lucide-react';
import {
  describeVfxGpuEffect,
  isVfxGpuEffectAsset,
  type VfxAuthoringDescriptor,
  type VfxAuthoringNodeDescriptor,
  type VfxAuthoringValue,
} from '@forgeax/engine-vfx';
import { useDocumentAsset } from './AssetEditors';
import { InspectorSection } from './asset-inspector/InspectorSection';
import { getVfxPreview } from './vfx-preview-slot';
import { toggleVfxEmitterHidden, useHiddenVfxEmitters } from './vfx-emitter-mask';
import './vfx-editor.css';

const ROLE_ICON: Record<string, ComponentType<{ size?: number }>> = {
  emitter: Sparkles,
  program: FileCode2,
  renderer: Layers,
  stage: Layers,
  parameters: SlidersHorizontal,
  custom: Braces,
  channel: Radio,
  event: Zap,
};

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

interface NodeTreeProps {
  readonly assetGuid: string;
  readonly nodes: readonly VfxAuthoringNodeDescriptor[];
  readonly depth: number;
  readonly selected: string;
  readonly collapsed: ReadonlySet<string>;
  readonly hidden: ReadonlySet<string>;
  readonly onToggleCollapse: (id: string) => void;
}

// Pure recursive tree renderer that reuses the global scene-Hierarchy `.tn` row
// chrome (eye · caret · icon · name), so the VFX System Outline reads exactly
// like the entity tree. Emitter rows own a visibility eye that drives the shared
// emitter mask (the preview viewport dispatches setEmitterMask off it).
function NodeTree({ assetGuid, nodes, depth, selected, collapsed, hidden, onToggleCollapse }: NodeTreeProps): ReactElement {
  return <>{nodes.map((node) => {
    const Icon = ROLE_ICON[node.role];
    const hasKids = node.children.length > 0;
    const isCollapsed = collapsed.has(node.id);
    const isEmitter = node.role === 'emitter';
    const isHidden = isEmitter && hidden.has(node.label);
    return (
      <div key={node.id}>
        <div
          className={`tn${selected === node.id ? ' sel' : ''}${isHidden ? ' dim' : ''}`}
          data-testid={`vfx-node-${node.id}`}
          onClick={() => selectNode(assetGuid, node.id)}
        >
          {isEmitter ? (
            <span
              className={`eye${isHidden ? ' off' : ''}`}
              data-testid={`vfx-node-vis-${node.label}`}
              title={isHidden ? 'Show emitter in preview' : 'Hide emitter in preview'}
              onClick={(event) => { event.stopPropagation(); toggleVfxEmitterHidden(assetGuid, node.label); }}
            >
              {isHidden ? <EyeOff size={13} aria-hidden="true" /> : <Eye size={13} aria-hidden="true" />}
            </span>
          ) : <span className="eye" aria-hidden="true" />}
          <span className="name-cell" style={{ paddingLeft: depth * 15 }}>
            <span
              className="caret"
              onClick={hasKids ? (event) => { event.stopPropagation(); onToggleCollapse(node.id); } : undefined}
              style={hasKids ? { cursor: 'pointer' } : undefined}
            >
              {hasKids
                ? (isCollapsed ? <ChevronRight size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />)
                : <span className="leafdot" />}
            </span>
            {Icon && <span className="ico" aria-hidden="true"><Icon size={15} /></span>}
            <span className="nm" title={node.label}>{node.label}</span>
            <span className="vfx-role-tag">{node.role}</span>
          </span>
        </div>
        {hasKids && !isCollapsed && (
          <NodeTree
            assetGuid={assetGuid}
            nodes={node.children}
            depth={depth + 1}
            selected={selected}
            collapsed={collapsed}
            hidden={hidden}
            onToggleCollapse={onToggleCollapse}
          />
        )}
      </div>
    );
  })}</>;
}

function PanelMessage({ children }: { readonly children: string }): ReactElement {
  return <div className="panel vfx-panel vfx-panel--message"><div className="field muted">{children}</div></div>;
}

export function VfxSystemPanel(): ReactElement {
  const state = useVfxDescriptor();
  const fallback = state.descriptor?.emitters[0]?.id ?? '';
  const selected = useSelectedNodeId(state.assetGuid, fallback);
  const hidden = useHiddenVfxEmitters(state.assetGuid);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggleCollapse = (id: string): void => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  if (!state.descriptor) return <PanelMessage>{state.error ?? 'VFX unavailable.'}</PanelMessage>;
  return (
    <div className="panel vfx-panel" data-testid="panel-vfx-system" data-subject-id={state.assetGuid}>
      <div className="vfx-tree">
        <NodeTree
          assetGuid={state.assetGuid}
          nodes={state.descriptor.emitters}
          depth={0}
          selected={selected}
          collapsed={collapsed}
          hidden={hidden}
          onToggleCollapse={toggleCollapse}
        />
      </div>
    </div>
  );
}

export function VfxDetailsPanel(): ReactElement {
  const state = useVfxDescriptor();
  const fallback = state.descriptor?.emitters[0]?.id ?? '';
  const selected = useSelectedNodeId(state.assetGuid, fallback);
  if (!state.descriptor) return <PanelMessage>{state.error ?? 'VFX unavailable.'}</PanelMessage>;
  const node = findNode(state.descriptor.emitters, selected) ?? state.descriptor.emitters[0];
  return <div className="panel vfx-panel" data-testid="panel-vfx-details" data-subject-id={state.assetGuid}>
    <div className="fx-inspector">
      <InspectorSection id="details" title={node?.label ?? 'Details'} dim="all">
        {node?.sourcePath && <div className="f-row" title={node.sourcePath}>
          <span className="f-name">Source</span>
          <span className="f-val"><span className="f-fact vfx-source-path">{node.sourcePath}</span></span>
        </div>}
        {node?.fields.map((entry) => <div className="f-row" key={entry.path} title={entry.path}>
          <span className="f-name">{entry.label}</span>
          <span className="f-val"><code className="f-fact">{renderValue(entry.value)}</code></span>
        </div>)}
      </InspectorSection>
    </div>
  </div>;
}

export function VfxTimelinePanel(): ReactElement {
  const state = useVfxDescriptor();
  if (!state.descriptor) return <PanelMessage>{state.error ?? 'VFX unavailable.'}</PanelMessage>;
  const maxDuration = Math.max(1, ...state.descriptor.timeline.map((track) => track.loopDuration ?? 1));
  return <div className="panel vfx-panel" data-testid="panel-vfx-timeline" data-subject-id={state.assetGuid}>
    <div className="fx-inspector">
      <InspectorSection id="timeline" title="Emitter Timeline" dim="type">
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
          <div className="field muted vfx-track-meta">loop {track.loopDuration === undefined ? 'continuous' : `${track.loopDuration}s`} · {track.bursts.length} bursts</div>
        </div>)}
      </InspectorSection>
    </div>
  </div>;
}

export function VfxDiagnosticsPanel(): ReactElement {
  const state = useVfxDescriptor();
  if (!state.descriptor) return <PanelMessage>{state.error ?? 'VFX unavailable.'}</PanelMessage>;
  return <div className="panel vfx-panel" data-testid="panel-vfx-diagnostics" data-subject-id={state.assetGuid}>
    <div className="fx-inspector">
      <InspectorSection id="capabilities" title="Capability Truth" dim="cap">
        {state.descriptor.capabilities.map((capability) => <div className="vfx-capability" key={capability.id}>
          <span data-state={capability.state}>{capability.state}</span>
          <strong>{capability.id}</strong>
          {capability.reason && <small>{capability.reason}</small>}
        </div>)}
      </InspectorSection>
      <InspectorSection id="dependencies" title="Dependencies" dim="all">
        {state.descriptor.dependencies.map((dependency) => <div className="vfx-dependency" key={`${dependency.kind}:${dependency.identity}`}>
          <span className="f-name">{dependency.kind}</span><code className="f-fact">{dependency.identity}</code>
        </div>)}
      </InspectorSection>
    </div>
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
