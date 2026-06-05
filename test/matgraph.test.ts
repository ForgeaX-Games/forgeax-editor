import { test, expect, beforeEach } from 'bun:test';
import {
  type MatGraph,
  evaluate, connect, disconnect, setParam, removeNode, addNode, hasPath,
  rgbToHex, hexToRgb, defaultGraph, resetGraphIds, pinType,
} from '../src/core/matgraph';

beforeEach(() => resetGraphIds());

test('hexToRgb / rgbToHex round-trip', () => {
  expect(rgbToHex([1, 0, 0])).toBe('#ff0000');
  expect(rgbToHex([0, 0, 0])).toBe('#000000');
  const c = hexToRgb('#3366cc');
  expect(c[0]).toBeCloseTo(0x33 / 255, 5);
  expect(rgbToHex(c)).toBe('#3366cc');
});

test('default graph evaluates albedo from its colorConst', () => {
  const g = defaultGraph();
  const r = evaluate(g)!;
  expect(r.albedo).toBe(rgbToHex([0.8, 0.8, 0.85]));
  expect(r.metallic).toBe(0); // unconnected → default
  expect(r.roughness).toBe(0.8);
  expect(r.emissive).toBe('#000000');
});

test('evaluate falls back to pin defaults when unconnected', () => {
  const g: MatGraph = { nodes: [{ id: 'out', kind: 'output', x: 0, y: 0, params: {} }], edges: [] };
  const r = evaluate(g)!;
  expect(r.albedo).toBe(rgbToHex([0.8, 0.8, 0.8]));
  expect(r.roughness).toBe(0.8);
});

test('mulScalar drives the metallic pin', () => {
  let g: MatGraph = { nodes: [{ id: 'out', kind: 'output', x: 0, y: 0, params: {} }], edges: [] };
  g = addNode(g, 'scalarConst', 0, 0, 'a'); g = setParam(g, 'a', 'v', 0.5);
  g = addNode(g, 'scalarConst', 0, 0, 'b'); g = setParam(g, 'b', 'v', 0.6);
  g = addNode(g, 'mulScalar', 0, 0, 'm');
  g = connect(g, { node: 'a', pin: 'out' }, { node: 'm', pin: 'a' });
  g = connect(g, { node: 'b', pin: 'out' }, { node: 'm', pin: 'b' });
  g = connect(g, { node: 'm', pin: 'out' }, { node: 'out', pin: 'metallic' });
  expect(evaluate(g)!.metallic).toBeCloseTo(0.3, 6);
});

test('mix node blends two colors by t', () => {
  let g: MatGraph = { nodes: [{ id: 'out', kind: 'output', x: 0, y: 0, params: {} }], edges: [] };
  g = addNode(g, 'colorConst', 0, 0, 'black'); g = setParam(g, 'black', 'rgb', [0, 0, 0]);
  g = addNode(g, 'colorConst', 0, 0, 'white'); g = setParam(g, 'white', 'rgb', [1, 1, 1]);
  g = addNode(g, 'scalarConst', 0, 0, 't'); g = setParam(g, 't', 'v', 0.25);
  g = addNode(g, 'mix', 0, 0, 'mx');
  g = connect(g, { node: 'black', pin: 'out' }, { node: 'mx', pin: 'a' });
  g = connect(g, { node: 'white', pin: 'out' }, { node: 'mx', pin: 'b' });
  g = connect(g, { node: 't', pin: 'out' }, { node: 'mx', pin: 't' });
  g = connect(g, { node: 'mx', pin: 'out' }, { node: 'out', pin: 'albedo' });
  expect(evaluate(g)!.albedo).toBe(rgbToHex([0.25, 0.25, 0.25]));
});

test('connect rejects a type mismatch (scalar → color pin)', () => {
  let g: MatGraph = { nodes: [{ id: 'out', kind: 'output', x: 0, y: 0, params: {} }], edges: [] };
  g = addNode(g, 'scalarConst', 0, 0, 's');
  const before = g.edges.length;
  g = connect(g, { node: 's', pin: 'out' }, { node: 'out', pin: 'albedo' }); // scalar→color
  expect(g.edges.length).toBe(before); // unchanged
});

test('connect rejects a cycle', () => {
  let g: MatGraph = { nodes: [], edges: [] };
  g = addNode(g, 'mulScalar', 0, 0, 'm1');
  g = addNode(g, 'mulScalar', 0, 0, 'm2');
  g = connect(g, { node: 'm1', pin: 'out' }, { node: 'm2', pin: 'a' });
  expect(hasPath(g, 'm1', 'm2')).toBe(true);
  const before = g.edges.length;
  g = connect(g, { node: 'm2', pin: 'out' }, { node: 'm1', pin: 'a' }); // would cycle
  expect(g.edges.length).toBe(before);
});

test('an input pin holds a single edge (reconnect replaces)', () => {
  let g: MatGraph = { nodes: [{ id: 'out', kind: 'output', x: 0, y: 0, params: {} }], edges: [] };
  g = addNode(g, 'scalarConst', 0, 0, 'a'); g = setParam(g, 'a', 'v', 0.2);
  g = addNode(g, 'scalarConst', 0, 0, 'b'); g = setParam(g, 'b', 'v', 0.9);
  g = connect(g, { node: 'a', pin: 'out' }, { node: 'out', pin: 'metallic' });
  g = connect(g, { node: 'b', pin: 'out' }, { node: 'out', pin: 'metallic' });
  expect(g.edges.filter((e) => e.to.pin === 'metallic').length).toBe(1);
  expect(evaluate(g)!.metallic).toBeCloseTo(0.9, 6);
});

test('disconnect / removeNode prune edges', () => {
  let g = defaultGraph();
  expect(g.edges.length).toBe(1);
  const d = disconnect(g, { node: 'out', pin: 'albedo' });
  expect(d.edges.length).toBe(0);
  g = removeNode(g, 'albedo');
  expect(g.nodes.some((n) => n.id === 'albedo')).toBe(false);
  expect(g.edges.length).toBe(0); // edge referencing it removed
});

test('pinType reports the schema', () => {
  expect(pinType('output', 'albedo', 'in')).toBe('color');
  expect(pinType('output', 'metallic', 'in')).toBe('scalar');
  expect(pinType('mulScalar', 'out', 'out')).toBe('scalar');
  expect(pinType('output', 'out', 'out')).toBeNull();
});
