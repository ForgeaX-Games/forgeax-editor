import { useRef, useState } from 'react';
import { bus, dispatch, useDocVersion, useSelection } from '@forgeax/editor-shared';
import { useTranslation } from '@forgeax/editor-shared/i18n';
import type { EditorCommand } from '@forgeax/editor-core';
import {
  type MatGraph, type GraphNode, type NodeKind, type RGB,
  KINDS, evaluate, connect, disconnect, setParam, moveNode, removeNode, addNode,
  defaultGraph, rgbToHex, hexToRgb, pinType,
} from '@forgeax/editor-core';

// Material Graph panel (design EDITOR-MODE P3) — a node canvas that authors a
// Material by wiring typed nodes (see core/matgraph.ts, pure + tested). The graph
// is stored on the entity's `MatGraph` component; structural edits evaluate the
// graph and write the result into the entity's `Material` (one undoable
// transaction), so the node graph drives the SAME material the renderer reads.

const NODE_W = 132, ROW_H = 18, HEAD_H = 22;
const ADDABLE: NodeKind[] = ['colorConst', 'scalarConst', 'mulScalar', 'mix', 'addColor'];
const KIND_LABEL: Record<NodeKind, string> = {
  colorConst: 'Color', scalarConst: 'Scalar', mulScalar: '× Scalar', mix: 'Mix', addColor: '+ Color', output: 'Output',
};

function graphOf(node: { components: Record<string, unknown> } | undefined): MatGraph {
  const raw = node?.components.MatGraph as { nodes?: GraphNode[]; edges?: MatGraph['edges'] } | undefined;
  if (raw && Array.isArray(raw.nodes) && Array.isArray(raw.edges)) return { nodes: raw.nodes, edges: raw.edges };
  return defaultGraph();
}
const inputPos = (n: GraphNode, i: number): { x: number; y: number } => ({ x: n.x, y: n.y + HEAD_H + i * ROW_H + ROW_H / 2 });
const outputPos = (n: GraphNode): { x: number; y: number } => ({ x: n.x + NODE_W, y: n.y + HEAD_H + ROW_H / 2 });

export function MaterialGraphPanel() {
  const { t } = useTranslation();
  useDocVersion();
  const sel = useSelection();
  const node = sel !== null ? bus.doc.entities[sel] : undefined;
  const graph = graphOf(node);
  const [pending, setPending] = useState<{ node: string; pin: string } | null>(null);
  const dragRef = useRef<{ id: string; gx: number; gy: number } | null>(null);
  const [, forceDrag] = useState(0);

  if (sel === null || !node) {
    return <div className="panel ed-matgraph" data-testid="panel-matgraph"><h3>Mat Graph</h3><div className="muted mg-empty">{t('editor.matgraph.empty')}</div></div>;
  }

  // Persist the graph; structural edits (applyMat) also evaluate → Material, all
  // in one undoable transaction. Node moves persist position only.
  const write = (g: MatGraph, applyMat: boolean): void => {
    const cmds: EditorCommand[] = [];
    const gd = { nodes: g.nodes, edges: g.edges };
    cmds.push(node.components.MatGraph
      ? { kind: 'setComponent', entity: sel, component: 'MatGraph', patch: gd }
      : { kind: 'addComponent', entity: sel, component: 'MatGraph', value: gd });
    if (applyMat) {
      const r = evaluate(g);
      if (r) {
        const patch = { albedo: r.albedo, metallic: r.metallic, roughness: r.roughness, emissive: r.emissive };
        cmds.push(node.components.Material
          ? { kind: 'setComponent', entity: sel, component: 'Material', patch }
          : { kind: 'addComponent', entity: sel, component: 'Material', value: patch });
      }
    }
    dispatch(cmds.length === 1 ? cmds[0]! : { kind: 'transaction', label: 'material graph', commands: cmds });
  };

  const onPin = (nodeId: string, pin: string, dir: 'in' | 'out'): void => {
    if (dir === 'out') { setPending({ node: nodeId, pin }); return; }
    if (pending) { write(connect(graph, pending, { node: nodeId, pin }), true); setPending(null); return; }
    // no pending + clicking an input → disconnect it (if wired)
    if (graph.edges.some((e) => e.to.node === nodeId && e.to.pin === pin)) write(disconnect(graph, { node: nodeId, pin }), true);
  };

  const startNodeDrag = (id: string, e: React.PointerEvent): void => {
    e.preventDefault();
    const n = graph.nodes.find((x) => x.id === id); if (!n) return;
    dragRef.current = { id, gx: e.clientX - n.x, gy: e.clientY - n.y };
    let cur = graph;
    const mv = (ev: PointerEvent): void => { const d = dragRef.current; if (!d) return; cur = moveNode(cur, id, Math.max(0, ev.clientX - d.gx), Math.max(0, ev.clientY - d.gy)); write(cur, false); };
    const up = (): void => { dragRef.current = null; window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); forceDrag((n2) => n2 + 1); };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };

  const result = evaluate(graph);

  return (
    <div className="panel ed-matgraph" data-testid="panel-matgraph">
      <h3>Mat Graph · {node.name}</h3>
      <div className="mg-toolbar">
        {ADDABLE.map((k) => (
          <button key={k} type="button" className="mg-add" title={t('editor.matgraph.addNode', { label: KIND_LABEL[k] })} onClick={() => write(addNode(graph, k, 20, 20 + graph.nodes.length * 8), false)}>+ {KIND_LABEL[k]}</button>
        ))}
        <span className="mg-sp" />
        {result && <span className="mg-out" title={t('editor.matgraph.evalResult')}><span className="mg-sw" style={{ background: result.albedo }} />{result.albedo} m{result.metallic.toFixed(2)} r{result.roughness.toFixed(2)}</span>}
      </div>

      <div className="mg-canvas" onClick={() => pending && setPending(null)}>
        <svg className="mg-wires">
          {graph.edges.map((ed, i) => {
            const a = graph.nodes.find((n) => n.id === ed.from.node);
            const b = graph.nodes.find((n) => n.id === ed.to.node);
            if (!a || !b) return null;
            const ii = KINDS[b.kind].inputs.findIndex((p) => p.pin === ed.to.pin);
            const p1 = outputPos(a), p2 = inputPos(b, Math.max(0, ii));
            return <path key={i} className="mg-wire" d={`M${p1.x},${p1.y} C${p1.x + 40},${p1.y} ${p2.x - 40},${p2.y} ${p2.x},${p2.y}`} />;
          })}
        </svg>
        {graph.nodes.map((n) => {
          const def = KINDS[n.kind];
          return (
            <div key={n.id} className={`mg-node${n.kind === 'output' ? ' out' : ''}`} style={{ left: n.x, top: n.y, width: NODE_W }}>
              <div className="mg-head" onPointerDown={(e) => startNodeDrag(n.id, e)}>
                {def.output && <span className={`mg-pin out${pending?.node === n.id ? ' on' : ''}`} title={t('editor.matgraph.outputPin')} onPointerDown={(e) => e.stopPropagation()} onClick={() => onPin(n.id, 'out', 'out')} />}
                <span className="mg-title">{KIND_LABEL[n.kind]}</span>
                {n.kind !== 'output' && <span className="mg-del" title={t('editor.matgraph.deleteNode')} onPointerDown={(e) => e.stopPropagation()} onClick={() => write(removeNode(graph, n.id), true)}>×</span>}
              </div>
              {n.kind === 'colorConst' && (
                <div className="mg-param">
                  <input type="color" value={rgbToHex((n.params.rgb as RGB) ?? [0.8, 0.8, 0.8])} onChange={(e) => write(setParam(graph, n.id, 'rgb', hexToRgb(e.target.value)), true)} />
                </div>
              )}
              {n.kind === 'scalarConst' && (
                <div className="mg-param">
                  <input type="range" min={0} max={1} step={0.01} value={typeof n.params.v === 'number' ? n.params.v : 0.5} onChange={(e) => write(setParam(graph, n.id, 'v', Number(e.target.value)), true)} />
                  <span className="mg-pv">{(typeof n.params.v === 'number' ? n.params.v : 0.5).toFixed(2)}</span>
                </div>
              )}
              {def.inputs.map((p) => {
                const wired = graph.edges.some((e) => e.to.node === n.id && e.to.pin === p.pin);
                const matchPending = pending && pinType(graph.nodes.find((x) => x.id === pending.node)!.kind, pending.pin, 'out') === p.type;
                return (
                  <div className="mg-in" key={p.pin}>
                    <span className={`mg-pin in t-${p.type}${wired ? ' wired' : ''}${matchPending ? ' ok' : ''}`} title={`${p.pin} (${p.type})${wired ? t('editor.matgraph.pinDisconnect') : pending ? t('editor.matgraph.pinConnect') : ''}`} onClick={() => onPin(n.id, p.pin, 'in')} />
                    <span className="mg-inlabel">{p.pin}</span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="muted mg-hint">{t('editor.matgraph.hint')}</div>
    </div>
  );
}
