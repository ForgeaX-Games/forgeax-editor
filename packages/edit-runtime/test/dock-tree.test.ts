import { test, expect, beforeEach } from 'bun:test';
import {
  tabs, split, resetIds,
  allPanels, leafOfPanel, firstLeaf, leafById,
  removePanel, movePanel, setActive, setActivePanel, setSizes, normalize, reconcile,
  type DockNode,
} from '../src/panels/dock-tree';

beforeEach(() => resetIds());

test('allPanels walks the whole tree in order', () => {
  const t = split('row', [tabs(['a', 'b']), split('col', [tabs(['c']), tabs(['d', 'e'])])]);
  expect(allPanels(t)).toEqual(['a', 'b', 'c', 'd', 'e']);
});

test('leafOfPanel / firstLeaf locate leaves', () => {
  const left = tabs(['a', 'b']);
  const right = tabs(['c']);
  const t = split('row', [left, right]);
  expect(leafOfPanel(t, 'b')!.id).toBe(left.id);
  expect(leafOfPanel(t, 'c')!.id).toBe(right.id);
  expect(firstLeaf(t)!.id).toBe(left.id);
  expect(leafOfPanel(t, 'zz')).toBeNull();
});

test('removePanel collapses an emptied leaf and its parent split', () => {
  const t = split('row', [tabs(['a']), tabs(['b'])]);
  const r = removePanel(t, 'a')!;
  // one leaf left → split collapses to that leaf
  expect(r.kind).toBe('tabs');
  expect(allPanels(r)).toEqual(['b']);
});

test('removePanel keeps a multi-panel leaf and fixes active', () => {
  const t = tabs(['a', 'b', 'c'], 2);
  const r = removePanel(t, 'c')! as Extract<DockNode, { kind: 'tabs' }>;
  expect(r.panels).toEqual(['a', 'b']);
  expect(r.active).toBe(1); // clamped from 2
});

test('movePanel center = tab into the target leaf', () => {
  const left = tabs(['a']);
  const right = tabs(['b']);
  const t = split('row', [left, right]);
  const r = movePanel(t, 'a', right.id, 'center');
  expect(r.kind).toBe('tabs'); // left collapsed; only right remains
  expect((r as Extract<DockNode, { kind: 'tabs' }>).panels).toEqual(['b', 'a']);
});

test('movePanel edge = split the target leaf in the right orientation', () => {
  const t = tabs(['a', 'b']);
  const r = movePanel(t, 'b', leafOfPanel(t, 'a')!.id, 'right');
  expect(r.kind).toBe('split');
  const s = r as Extract<DockNode, { kind: 'split' }>;
  expect(s.dir).toBe('row');
  expect(allPanels(s)).toEqual(['a', 'b']); // a stays left, b new leaf right
  expect(s.sizes.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 6);
});

test('movePanel top = column split, new leaf before', () => {
  const t = tabs(['a', 'b']);
  const r = movePanel(t, 'b', leafOfPanel(t, 'a')!.id, 'top') as Extract<DockNode, { kind: 'split' }>;
  expect(r.dir).toBe('col');
  expect(r.children[0]!.kind).toBe('tabs');
  expect(allPanels(r.children[0]!)).toEqual(['b']); // 'top' → before
  expect(allPanels(r.children[1]!)).toEqual(['a']);
});

test('movePanel onto its own singleton leaf is a no-op', () => {
  const t = split('row', [tabs(['a']), tabs(['b'])]);
  const leafA = leafOfPanel(t, 'a')!.id;
  expect(movePanel(t, 'a', leafA, 'center')).toBe(t);
  expect(movePanel(t, 'a', leafA, 'left')).toBe(t);
});

test('normalize flattens same-direction nesting', () => {
  const nested = split('row', [tabs(['a']), split('row', [tabs(['b']), tabs(['c'])])]);
  const n = normalize(nested) as Extract<DockNode, { kind: 'split' }>;
  expect(n.dir).toBe('row');
  expect(n.children.length).toBe(3);
  expect(allPanels(n)).toEqual(['a', 'b', 'c']);
});

test('setActive / setActivePanel update the leaf head', () => {
  const t = tabs(['a', 'b', 'c']);
  expect((setActive(t, t.id, 2) as Extract<DockNode, { kind: 'tabs' }>).active).toBe(2);
  expect((setActivePanel(t, t.id, 'b') as Extract<DockNode, { kind: 'tabs' }>).active).toBe(1);
});

test('setSizes renormalizes to sum 1 with a floor', () => {
  const t = split('row', [tabs(['a']), tabs(['b'])]);
  const r = setSizes(t, t.id, [3, 1]) as Extract<DockNode, { kind: 'split' }>;
  expect(r.sizes[0]!).toBeCloseTo(0.75, 6);
  expect(r.sizes[1]!).toBeCloseTo(0.25, 6);
});

test('reconcile drops unknown panels and appends missing ones', () => {
  const t = split('row', [tabs(['a', 'gone']), tabs(['b'])]);
  const r = reconcile(t, ['a', 'b', 'c']);
  expect(allPanels(r).sort()).toEqual(['a', 'b', 'c']);
  expect(allPanels(r)).not.toContain('gone');
});

test('reconcile builds a fresh leaf when there is no tree', () => {
  const r = reconcile(null, ['a', 'b']);
  expect(r.kind).toBe('tabs');
  expect(allPanels(r)).toEqual(['a', 'b']);
});

test('reconcile de-dupes a panel that appears twice', () => {
  const t = split('row', [tabs(['a']), tabs(['a', 'b'])]);
  const r = reconcile(t, ['a', 'b']);
  expect(allPanels(r).sort()).toEqual(['a', 'b']);
});
