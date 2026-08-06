import { describe, expect, it } from 'bun:test';
import { encodePageKey, qualifyContributionId } from '@forgeax/types';
import { createContributionRegistry } from '../extension-foundation/contribution-registry';
import { createPageRegistry } from './registry';
import { createPageSession } from './session';
import type { PageController, PagePlatformContribution, PageTypeRegistration } from './types';

const owner = '@forgeax-plugin/session-test';
const panelId = qualifyContributionId(owner, 'panel', 'main');
const singletonId = qualifyContributionId(owner, 'page', 'singleton');
const resourceId = qualifyContributionId(owner, 'page', 'resource');

function setup(pageTypes: readonly PageTypeRegistration[]) {
  const contributions = createContributionRegistry<PagePlatformContribution>();
  const registry = createPageRegistry(contributions);
  const cleanup = contributions.contribute(owner, {
    panelTypes: [{ id: panelId, runtime: { kind: 'inline', render: () => null } }],
    pageTypes,
  });
  const session = createPageSession(registry, { createInstanceId: () => 'generated', now: () => 42 });
  return { contributions, registry, cleanup, session };
}

function page(id: string, cardinality: 'singleton' | 'resource' | 'multi-instance', controller?: PageController): PageTypeRegistration {
  return {
    id,
    title: id,
    cardinality,
    layout: { version: 1, root: { kind: 'tabs', placements: ['main'] } },
    panels: [{ id: 'main', panelTypeId: panelId }],
    ...(controller ? { createController: () => controller } : {}),
  };
}

describe('PageSession', () => {
  it('deduplicates singleton opens and focuses the existing instance', async () => {
    const { session } = setup([page(singletonId, 'singleton')]);
    const first = await session.open({ typeId: singletonId, context: { source: 'first' } });
    const second = await session.open({ typeId: singletonId, context: { source: 'second' } });

    expect(second).toEqual(first);
    expect(session.getSnapshot().instances).toHaveLength(1);
    expect(session.getSnapshot().instances[0]?.context).toEqual({ source: 'first' });
    expect(session.getSnapshot().activeKey).toBe(encodePageKey(first));
  });

  it('keys resource pages by the resource owner canonical id', async () => {
    const { session } = setup([page(resourceId, 'resource')]);
    const descriptor = { canonicalId: 'asset://hero', uri: 'asset://hero', kind: 'asset' };
    const first = await session.open({ typeId: resourceId, resource: descriptor });
    const second = await session.open({ typeId: resourceId, resource: descriptor });

    expect(first).toEqual(second);
    expect(session.getSnapshot().instances).toHaveLength(1);
  });

  it('requires an explicit save/discard decision for dirty pages', async () => {
    let dirty = true;
    let disposed = 0;
    const controller: PageController = {
      prepareClose: () => (dirty ? { status: 'dirty', message: 'Unsaved' } : { status: 'ready' }),
      save: () => { dirty = false; },
      discard: () => { dirty = false; },
      dispose: () => { disposed++; },
    };
    const { session } = setup([page(singletonId, 'singleton', controller)]);
    const key = await session.open({ typeId: singletonId });

    await expect(session.close(key)).rejects.toMatchObject({ code: 'PAGE_CLOSE_REQUIRES_DECISION' });
    expect(session.getSnapshot().instances).toHaveLength(1);
    await session.close(key, { decision: 'save' });
    expect(session.getSnapshot().instances).toHaveLength(0);
    expect(disposed).toBe(1);
  });

  it('reorders open pages and clamps the target index', async () => {
    const multiId = qualifyContributionId(owner, 'page', 'multi');
    const { session } = setup([page(multiId, 'multi-instance')]);
    const a = await session.open({ typeId: multiId, instanceId: 'a' });
    const b = await session.open({ typeId: multiId, instanceId: 'b' });
    const c = await session.open({ typeId: multiId, instanceId: 'c' });
    const ids = () => session.getSnapshot().instances.map((i) => i.encodedKey);

    expect(ids()).toEqual([a, b, c].map(encodePageKey));

    session.reorder(c, 0);
    expect(ids()).toEqual([c, a, b].map(encodePageKey));

    // Out-of-range target clamps to the last slot instead of throwing.
    session.reorder(c, 99);
    expect(ids()).toEqual([a, b, c].map(encodePageKey));

    // A no-op move publishes nothing new.
    const gen = session.getSnapshot().generation;
    session.reorder(c, 2);
    expect(session.getSnapshot().generation).toBe(gen);
  });

  it('reflects a controller reactive title into the snapshot and cleans it up on close', async () => {
    let sceneName: string | undefined = 'MainScene';
    const titleListeners = new Set<() => void>();
    const controller: PageController = {
      prepareClose: () => ({ status: 'ready' }),
      dispose: () => undefined,
      getTitle: () => sceneName,
      subscribeTitle: (listener) => {
        titleListeners.add(listener);
        return () => titleListeners.delete(listener);
      },
    };
    // A resource page keeps the level-style singleton free; controller drives title.
    const closableSingleton: PageTypeRegistration = { ...page(singletonId, 'singleton', controller), closable: true };
    const { session } = setup([closableSingleton]);
    const key = await session.open({ typeId: singletonId });

    // Initial title is present in the very first snapshot (read synchronously).
    expect(session.getSnapshot().instances[0]?.title).toBe('MainScene');

    // A controller change event republishes with the new title (event-driven).
    sceneName = 'Level_02';
    for (const l of titleListeners) l();
    expect(session.getSnapshot().instances[0]?.title).toBe('Level_02');

    // An unchanged re-notification publishes nothing new.
    const gen = session.getSnapshot().generation;
    for (const l of titleListeners) l();
    expect(session.getSnapshot().generation).toBe(gen);

    // Closing unsubscribes: further notifications are inert.
    await session.close(key);
    expect(titleListeners.size).toBe(0);
  });

  it('delegates context-menu items to the page controller and evaluates them fresh', async () => {
    let dirty = false;
    const controller: PageController = {
      prepareClose: () => ({ status: 'ready' }),
      dispose: () => undefined,
      getContextMenuItems: () => [
        { id: 'copy', label: 'Copy path', icon: 'copy', group: 'file', run: () => undefined },
        { id: 'save', label: 'Save', icon: 'save', group: 'save', disabled: !dirty, run: () => undefined },
      ],
    };
    const { session } = setup([page(singletonId, 'singleton', controller)]);
    const key = await session.open({ typeId: singletonId });

    // Fresh evaluation: save disabled until the (mock) page becomes dirty.
    expect(session.getContextMenuItems(key).map((i) => i.id)).toEqual(['copy', 'save']);
    expect(session.getContextMenuItems(key).find((i) => i.id === 'save')?.disabled).toBe(true);
    dirty = true;
    expect(session.getContextMenuItems(key).find((i) => i.id === 'save')?.disabled).toBe(false);
  });

  it('returns no context-menu items for a controllerless page', async () => {
    const { session } = setup([page(singletonId, 'singleton')]);
    const key = await session.open({ typeId: singletonId });
    expect(session.getContextMenuItems(key)).toEqual([]);
  });

  it('preflights every owned page before an extension cleanup removes any', async () => {
    const secondId = qualifyContributionId(owner, 'page', 'second');
    const ready: PageController = { prepareClose: () => ({ status: 'ready' }), dispose: () => undefined };
    const dirty: PageController = { prepareClose: () => ({ status: 'dirty' }), dispose: () => undefined };
    const { session } = setup([
      page(singletonId, 'singleton', ready),
      page(secondId, 'singleton', dirty),
    ]);
    await session.open({ typeId: singletonId });
    await session.open({ typeId: secondId });

    await expect(session.closeOwnedBy(owner)).rejects.toMatchObject({ code: 'PAGE_CLOSE_REQUIRES_DECISION' });
    expect(session.getSnapshot().instances).toHaveLength(2);
  });
});
