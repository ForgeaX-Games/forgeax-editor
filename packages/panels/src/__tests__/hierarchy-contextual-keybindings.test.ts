import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach, describe, expect, it } from 'bun:test';
import { createAppHost, HostProvider } from '@forgeax/interface/core/app-shell';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { World } from '@forgeax/engine-ecs';
import { Name } from '@forgeax/engine-scene';
import { gateway } from '@forgeax/editor-core';
import { registerHierarchyScopedCommands } from '../HierarchyContributions';
import {
  createHierarchyCommandActions,
  HierarchyPanel,
  type HierarchyCommandActions,
} from '../Hierarchy';

try { GlobalRegistrator.register(); } catch { /* shared DOM test environment */ }

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  document.body.replaceChildren();
});

describe('Hierarchy contextual keybindings', () => {
  it('derives command targets from the focused row before the selection', () => {
    const calls: Array<string | readonly number[]> = [];
    let focused = 1 as never;
    let selected = [1, 2] as never[];
    const actions = createHierarchyCommandActions({
      readOnly: false,
      getFocusedEntity: () => focused,
      getSelectedEntities: () => selected,
      renameEntity: (entity) => calls.push(`rename:${entity}`),
      deleteEntities: (entities) => calls.push(entities),
      selectAll: () => calls.push('selectAll'),
    });

    expect(actions.canMutateFocusedTarget).toBe(true);
    expect(actions.canRenameFocusedTarget).toBe(true);
    actions.renameFocused();
    actions.deleteFocused();
    actions.selectAll();

    focused = 3 as never;
    actions.deleteFocused();
    focused = null as never;
    selected = [];
    expect(actions.canMutateFocusedTarget).toBe(false);
    expect(actions.canRenameFocusedTarget).toBe(false);
    actions.renameFocused();
    actions.deleteFocused();

    expect(calls).toEqual(['rename:1', [1, 2], 'selectAll', [3]]);
  });

  it('keeps mutations disabled for a read-only hierarchy', () => {
    const calls: string[] = [];
    const actions = createHierarchyCommandActions({
      readOnly: true,
      getFocusedEntity: () => 1 as never,
      getSelectedEntities: () => [1 as never],
      renameEntity: () => calls.push('rename'),
      deleteEntities: () => calls.push('delete'),
      selectAll: () => calls.push('selectAll'),
    });

    expect(actions.canMutateFocusedTarget).toBe(false);
    expect(actions.canRenameFocusedTarget).toBe(false);
    actions.renameFocused();
    actions.deleteFocused();
    expect(calls).toEqual([]);
  });

  it('renders the live hierarchy surface that owns the scoped commands', () => {
    const world = new World();
    const root = world.spawn({ component: Name, data: { value: 'Scoped Root' } });
    expect(root.ok).toBe(true);
    const doc = gateway.doc as { world: unknown };
    const originalWorld = doc.world;
    doc.world = world;
    try {
      const { host } = createAppHost();
      const html = renderToStaticMarkup(
        createElement(HostProvider, {
          value: host,
          children: createElement(HierarchyPanel),
        }),
      );
      expect(html).toContain('data-testid="panel-hierarchy"');
      expect(html).toContain('data-testid="hierarchy-virtual-rows"');
      expect(html).toContain('height:25px');
    } finally {
      doc.world = originalWorld;
    }
  });

  it('runs focused-scope rename/delete/select-all command bodies', async () => {
    const { host } = createAppHost();
    const root = document.createElement('div');
    document.body.append(root);
    const calls: string[] = [];
    const actions: HierarchyCommandActions = {
      canMutateFocusedTarget: true,
      canRenameFocusedTarget: true,
      renameFocused: () => calls.push('rename'),
      deleteFocused: () => calls.push('delete'),
      selectAll: () => calls.push('selectAll'),
    };
    cleanups.push(
      host.keybindings.registerScope(root, 'editor.hierarchy'),
      ...registerHierarchyScopedCommands(host, () => actions),
    );

    const dispatch = (init: KeyboardEventInit) => {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      root.addEventListener('keydown', current => host.keybindings.handle(current as KeyboardEvent), { once: true });
      root.dispatchEvent(event);
    };
    dispatch({ key: 'F2' });
    dispatch({ key: 'Delete' });
    dispatch({ key: 'a', ctrlKey: true });
    await Promise.resolve();

    expect(calls).toEqual(['rename', 'delete', 'selectAll']);
  });
});
