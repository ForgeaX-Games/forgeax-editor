import { beforeEach, describe, expect, it } from 'bun:test';
import { qualifyContributionId } from '@forgeax/types';
import { createContributionRegistry } from '../extension-foundation/contribution-registry';
import { createResourceEditorResolver } from './resource-editor';
import type { PagePlatformContribution, PagePort, ResourceEditorRegistration } from './types';

const owner = '@forgeax/resource-test';
const pageTypeId = qualifyContributionId(owner, 'page', 'viewer') as ResourceEditorRegistration['pageTypeId'];
const resource = { canonicalId: 'asset:one', uri: 'file:///game/hero.glb', kind: 'mesh' };

function editor(localId: string, overrides: Partial<ResourceEditorRegistration> = {}): ResourceEditorRegistration {
  return {
    id: qualifyContributionId(owner, 'resource-editor', localId) as ResourceEditorRegistration['id'],
    selector: { extensions: ['glb'] },
    pageTypeId,
    priority: 'optional',
    sourceLayer: 'installed',
    ...overrides,
  };
}

describe('ResourceEditorResolver', () => {
  beforeEach(() => localStorage.clear());

  it('orders by source layer, priority, then stable id', () => {
    const contributions = createContributionRegistry<PagePlatformContribution>();
    const resolver = createResourceEditorResolver(contributions, {} as PagePort);
    const optionalUser = editor('z-user', { sourceLayer: 'user' });
    const defaultProject = editor('a-project', { sourceLayer: 'project', priority: 'default' });
    const defaultInstalled = editor('b-installed', { priority: 'default' });
    contributions.contribute(owner, { resourceEditors: [defaultInstalled, defaultProject, optionalUser] });

    expect(resolver.list(resource).map((item) => item.id)).toEqual([
      optionalUser.id,
      defaultProject.id,
      defaultInstalled.id,
    ]);
  });

  it('lets a user association override deterministic defaults', () => {
    const contributions = createContributionRegistry<PagePlatformContribution>();
    const resolver = createResourceEditorResolver(contributions, {} as PagePort);
    const first = editor('a');
    const selected = editor('b');
    contributions.contribute(owner, { resourceEditors: [first, selected] });
    resolver.setUserAssociation(resource, selected.id);
    expect(resolver.resolve(resource)?.id).toBe(selected.id);
  });

  it('reserves the fallback tier for resources no targeted editor claims', () => {
    const contributions = createContributionRegistry<PagePlatformContribution>();
    const resolver = createResourceEditorResolver(contributions, {} as PagePort);
    const targeted = editor('mesh-view', { selector: { kinds: ['mesh'] } });
    // Deliberately the highest source layer: tier beats layer, so a default
    // editor can never shadow an editor that actually claims the resource.
    const fallback = editor('default-view', { selector: { fallback: true }, priority: 'default', sourceLayer: 'user' });
    contributions.contribute(owner, { resourceEditors: [fallback, targeted] });

    expect(resolver.list(resource).map((item) => item.id)).toEqual([targeted.id, fallback.id]);
    // `asset.kind` is an open string; an engine kind nobody declared must still
    // open somewhere rather than raise RESOURCE_EDITOR_NOT_FOUND.
    const undeclared = { canonicalId: 'asset:two', uri: 'forgeax-asset://two', kind: 'particle-effect' };
    expect(resolver.resolve(undeclared)?.id).toBe(fallback.id);
  });

  it('lets a user association lift the default editor above a targeted one', () => {
    const contributions = createContributionRegistry<PagePlatformContribution>();
    const resolver = createResourceEditorResolver(contributions, {} as PagePort);
    const targeted = editor('mesh-view', { selector: { kinds: ['mesh'] }, priority: 'default', sourceLayer: 'builtin' });
    const fallback = editor('default-view', { selector: { fallback: true } });
    contributions.contribute(owner, { resourceEditors: [targeted, fallback] });

    resolver.setUserAssociation(resource, fallback.id);
    expect(resolver.resolve(resource)?.id).toBe(fallback.id);
  });

  it('opens the selected page with the canonical descriptor', async () => {
    const contributions = createContributionRegistry<PagePlatformContribution>();
    const opened: unknown[] = [];
    const pages = { open: async (request: unknown) => { opened.push(request); return { cardinality: 'resource', typeId: pageTypeId, resourceId: resource.canonicalId }; } } as PagePort;
    const resolver = createResourceEditorResolver(contributions, pages);
    contributions.contribute(owner, { resourceEditors: [editor('viewer')] });

    await resolver.open(resource);
    expect(opened).toEqual([{ typeId: pageTypeId, resource }]);
  });
});
