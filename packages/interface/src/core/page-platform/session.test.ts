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
