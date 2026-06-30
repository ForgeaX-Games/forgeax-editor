// Material node graph (design EDITOR-MODE P3 "材质节点图" / studio Material Graph).
// PURE model + evaluator (no React/engine), unit-tested headlessly; the node
// canvas panel is a thin shell over it. A graph evaluates to a flat Material patch
// (albedo/metallic/roughness/emissive) the editor applies to an entity's Material
// via the command bus — so a node graph authors the SAME Material the renderer
// reads, no separate runtime.

export type PinType = 'color' | 'scalar';
export type RGB = [number, number, number];
export type Value = number | RGB;

export type NodeKind = 'colorConst' | 'scalarConst' | 'mulScalar' | 'mix' | 'addColor' | 'output';

export interface GraphNode {
  id: string;
  kind: NodeKind;
  x: number; y: number; // canvas position (UI only; ignored by eval)
  params: Record<string, unknown>;
}
export interface Edge {
  from: { node: string; pin: string }; // an OUTPUT pin
  to: { node: string; pin: string };   // an INPUT pin
}
export interface MatGraph {
  nodes: GraphNode[];
  edges: Edge[];
}

/** Per-kind pin schema: typed inputs (with defaults) + the single output type. */
interface PinDef { pin: string; type: PinType; def: Value }
interface KindDef { inputs: PinDef[]; output: PinType | null }
export const KINDS: Record<NodeKind, KindDef> = {
  colorConst: { inputs: [], output: 'color' },
  scalarConst: { inputs: [], output: 'scalar' },
  mulScalar: { inputs: [{ pin: 'a', type: 'scalar', def: 1 }, { pin: 'b', type: 'scalar', def: 1 }], output: 'scalar' },
  addColor: { inputs: [{ pin: 'a', type: 'color', def: [0, 0, 0] }, { pin: 'b', type: 'color', def: [0, 0, 0] }], output: 'color' },
  mix: { inputs: [{ pin: 'a', type: 'color', def: [0, 0, 0] }, { pin: 'b', type: 'color', def: [1, 1, 1] }, { pin: 't', type: 'scalar', def: 0 }], output: 'color' },
  output: {
    inputs: [
      { pin: 'albedo', type: 'color', def: [0.8, 0.8, 0.8] },
      { pin: 'metallic', type: 'scalar', def: 0 },
      { pin: 'roughness', type: 'scalar', def: 0.8 },
      { pin: 'emissive', type: 'color', def: [0, 0, 0] },
    ],
    output: null,
  },
};

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const isRGB = (v: unknown): v is RGB => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number');
const asRGB = (v: Value, d: RGB): RGB => (isRGB(v) ? v : d);
const asNum = (v: Value, d: number): number => (typeof v === 'number' ? v : d);

function hex2(n: number): string { return Math.round(clamp01(n) * 255).toString(16).padStart(2, '0'); }
export function rgbToHex([r, g, b]: RGB): string { return `#${hex2(r)}${hex2(g)}${hex2(b)}`; }
export function hexToRgb(h: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
  if (!m) return [0.8, 0.8, 0.8];
  const n = parseInt(m[1]!, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// ── evaluation ────────────────────────────────────────────────────────────────

function evalNode(g: MatGraph, id: string, cache: Map<string, Value>, stack: Set<string>): Value {
  const cached = cache.get(id);
  if (cached !== undefined) return cached;
  if (stack.has(id)) return 0; // cycle guard
  stack.add(id);
  const node = g.nodes.find((n) => n.id === id);
  let out: Value = 0;
  if (node) {
    const inp = (pin: string, def: Value): Value => inputValue(g, id, pin, cache, stack, def);
    switch (node.kind) {
      case 'colorConst': out = asRGB(node.params.rgb as Value, [1, 1, 1]); break;
      case 'scalarConst': out = num(node.params.v, 0); break;
      case 'mulScalar': out = asNum(inp('a', 1), 1) * asNum(inp('b', 1), 1); break;
      case 'addColor': { const a = asRGB(inp('a', [0, 0, 0]), [0, 0, 0]), b = asRGB(inp('b', [0, 0, 0]), [0, 0, 0]); out = [clamp01(a[0] + b[0]), clamp01(a[1] + b[1]), clamp01(a[2] + b[2])]; break; }
      case 'mix': { const a = asRGB(inp('a', [0, 0, 0]), [0, 0, 0]), b = asRGB(inp('b', [1, 1, 1]), [1, 1, 1]), t = clamp01(asNum(inp('t', 0), 0)); out = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; break; }
      default: out = 0;
    }
  }
  stack.delete(id);
  cache.set(id, out);
  return out;
}

function inputValue(g: MatGraph, nodeId: string, pin: string, cache: Map<string, Value>, stack: Set<string>, def: Value): Value {
  const e = g.edges.find((ed) => ed.to.node === nodeId && ed.to.pin === pin);
  if (e) return evalNode(g, e.from.node, cache, stack);
  return def;
}

export interface MaterialResult { albedo: string; metallic: number; roughness: number; emissive: string }

/** Evaluate the graph at its (first) output node → a Material patch. */
export function evaluate(g: MatGraph): MaterialResult | null {
  const out = g.nodes.find((n) => n.kind === 'output');
  if (!out) return null;
  const cache = new Map<string, Value>(), stack = new Set<string>();
  const get = (pin: string, def: Value): Value => inputValue(g, out.id, pin, cache, stack, def);
  return {
    albedo: rgbToHex(asRGB(get('albedo', [0.8, 0.8, 0.8]), [0.8, 0.8, 0.8])),
    metallic: clamp01(asNum(get('metallic', 0), 0)),
    roughness: clamp01(asNum(get('roughness', 0.8), 0.8)),
    emissive: rgbToHex(asRGB(get('emissive', [0, 0, 0]), [0, 0, 0])),
  };
}

// ── editing (immutable) ───────────────────────────────────────────────────────

export function pinType(kind: NodeKind, pin: string, dir: 'in' | 'out'): PinType | null {
  const k = KINDS[kind];
  if (dir === 'out') return pin === 'out' ? k.output : null;
  return k.inputs.find((i) => i.pin === pin)?.type ?? null;
}

/** Does a directed data path exist from `src` node to `dst` node? (cycle check) */
export function hasPath(g: MatGraph, src: string, dst: string): boolean {
  if (src === dst) return true;
  const seen = new Set<string>();
  const stack = [src];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === dst) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const e of g.edges) if (e.from.node === cur) stack.push(e.to.node);
  }
  return false;
}

/** Connect an output pin → input pin. Rejects type mismatches and cycles; an
 *  input takes a single edge (a new connection replaces the old). Returns the
 *  same graph (unchanged) if the connection is invalid. */
export function connect(g: MatGraph, from: Edge['from'], to: Edge['to']): MatGraph {
  const outT = pinType(nodeKind(g, from.node), from.pin, 'out');
  const inT = pinType(nodeKind(g, to.node), to.pin, 'in');
  if (!outT || !inT || outT !== inT) return g;
  if (from.node === to.node) return g;
  // adding from→to creates a cycle iff `to` already reaches `from`.
  if (hasPath(g, to.node, from.node)) return g;
  const edges = g.edges.filter((e) => !(e.to.node === to.node && e.to.pin === to.pin));
  edges.push({ from, to });
  return { ...g, edges };
}

export function disconnect(g: MatGraph, to: Edge['to']): MatGraph {
  return { ...g, edges: g.edges.filter((e) => !(e.to.node === to.node && e.to.pin === to.pin)) };
}

export function setParam(g: MatGraph, nodeId: string, key: string, value: unknown): MatGraph {
  return { ...g, nodes: g.nodes.map((n) => (n.id === nodeId ? { ...n, params: { ...n.params, [key]: value } } : n)) };
}

export function moveNode(g: MatGraph, nodeId: string, x: number, y: number): MatGraph {
  return { ...g, nodes: g.nodes.map((n) => (n.id === nodeId ? { ...n, x, y } : n)) };
}

export function removeNode(g: MatGraph, nodeId: string): MatGraph {
  return { nodes: g.nodes.filter((n) => n.id !== nodeId), edges: g.edges.filter((e) => e.from.node !== nodeId && e.to.node !== nodeId) };
}

let _gseq = 0;
export function resetGraphIds(): void { _gseq = 0; }
export function addNode(g: MatGraph, kind: NodeKind, x = 40, y = 40, id?: string): MatGraph {
  const node: GraphNode = { id: id ?? `n${++_gseq}`, kind, x, y, params: defaultParams(kind) };
  return { ...g, nodes: [...g.nodes, node] };
}
function defaultParams(kind: NodeKind): Record<string, unknown> {
  if (kind === 'colorConst') return { rgb: [0.8, 0.8, 0.8] };
  if (kind === 'scalarConst') return { v: 0.5 };
  return {};
}
function nodeKind(g: MatGraph, id: string): NodeKind {
  return g.nodes.find((n) => n.id === id)?.kind ?? 'output';
}

/** A starter graph: an output node fed by a colorConst albedo. */
export function defaultGraph(): MatGraph {
  resetGraphIds();
  const out: GraphNode = { id: 'out', kind: 'output', x: 320, y: 60, params: {} };
  const col: GraphNode = { id: 'albedo', kind: 'colorConst', x: 40, y: 40, params: { rgb: [0.8, 0.8, 0.85] } };
  return { nodes: [col, out], edges: [{ from: { node: 'albedo', pin: 'out' }, to: { node: 'out', pin: 'albedo' } }] };
}
