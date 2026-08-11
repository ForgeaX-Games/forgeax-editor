import { afterEach, describe, expect, it } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { qualifyContributionId } from '@forgeax/types';
import { createAppHost, HostProvider } from '../../core/app-shell';
import type { ActivityRegistration } from '../../core/page-platform';
import { ActivityRail } from './ActivityRail';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function activity(
  owner: string,
  localId: string,
  title: string,
  overrides: Partial<ActivityRegistration> = {},
): ActivityRegistration {
  return {
    id: qualifyContributionId(owner, 'activity', localId),
    title,
    commandId: `${owner}.${localId}`,
    ...overrides,
  };
}

describe('ActivityRail', () => {
  it('keeps the complete plugin catalog discoverable when every activity is pinned', async () => {
    const { host, control } = createAppHost();
    const builtinOwner = '@forgeax/core';
    const pluginOwner = '@forgeax-extension/wb-skill';
    const builtin = activity(builtinOwner, 'editor', 'Editor', {
      sourceLayer: 'builtin',
      icon: 'Box',
    });
    const plugin = activity(pluginOwner, 'launcher', 'Skill VFX', {
      sourceLayer: 'installed',
      icon: 'Sparkles',
      category: '3D',
      description: 'Author combat effects',
    });
    host.commands.register({ id: builtin.commandId!, execute: () => undefined });
    host.commands.register({ id: plugin.commandId!, execute: () => undefined });
    control.contributePagePlatform(builtinOwner, { activities: [builtin] });
    control.contributePagePlatform(pluginOwner, { activities: [plugin] });

    const { container } = render(
      <HostProvider value={host}>
        <ActivityRail />
      </HostProvider>,
    );

    expect(screen.getByRole('button', { name: 'Editor' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Skill VFX' })).toBeTruthy();
    const builtinGroup = container.querySelector('[data-category="builtin"]');
    expect(builtinGroup?.nextElementSibling?.getAttribute('data-category')).toBe('pinned');
    const more = screen.getByRole('button', { name: /more plugins/i });
    await act(async () => { fireEvent.click(more); });

    expect(screen.getByRole('searchbox', { name: /search plugins/i })).toBeTruthy();
    expect(document.querySelector('.activity-rail-more-name')?.textContent).toBe('Skill VFX');
    expect(screen.getByText('Author combat effects')).toBeTruthy();
  });

  it('searches the catalog and supports pin/unpin without removing discovery rows', async () => {
    const { host, control } = createAppHost();
    const owner = '@forgeax-extension/wb-items';
    const plugin = activity(owner, 'launcher', 'Items & Icons', {
      sourceLayer: 'installed',
      icon: 'Backpack',
      category: '2D',
      description: 'Create an item atlas',
    });
    host.commands.register({ id: plugin.commandId!, execute: () => undefined });
    control.contributePagePlatform(owner, { activities: [plugin] });

    const { container } = render(
      <HostProvider value={host}>
        <ActivityRail />
      </HostProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /more plugins/i }));
    });
    const search = screen.getByRole('searchbox', { name: /search plugins/i });
    await act(async () => { fireEvent.change(search, { target: { value: 'atlas' } }); });
    const row = document.querySelector('.activity-rail-more-row');
    expect(row).toBeTruthy();

    const unpin = within(row as HTMLElement).getByRole('button', { name: /unpin from sidebar/i });
    await act(async () => { fireEvent.click(unpin); });
    expect(container.querySelector(`[data-activity-id="${plugin.id}"]`)).toBeNull();
    expect(document.querySelector('.activity-rail-more-name')?.textContent).toBe('Items & Icons');
    expect(within(row as HTMLElement).getByRole('button', { name: /pin to sidebar/i })).toBeTruthy();
  });
});
