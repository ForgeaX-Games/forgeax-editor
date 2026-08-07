import type { QualifiedResourceEditorId, ResourceDescriptor } from '@forgeax/types';
import type { ContributionRegistry } from '../extension-foundation/contribution-registry';
import type {
  PagePlatformContribution,
  PagePort,
  ResourceEditorRegistration,
  ResourceEditorResolver,
} from './types';
import { PagePlatformError } from './types';

const ASSOCIATIONS_KEY = 'forgeax.resource-editor-associations.v1';
const layerRank = { builtin: 0, installed: 1, project: 2, user: 3 } as const;

function matches(editor: ResourceEditorRegistration, resource: ResourceDescriptor): boolean {
  const selector = editor.selector;
  let scheme: string | undefined;
  try { scheme = new URL(resource.uri).protocol.replace(/:$/u, ''); } catch { /* path-like URI */ }
  const path = (resource.displayPath ?? resource.uri).split(/[?#]/u, 1)[0] ?? '';
  const leaf = path.slice(path.lastIndexOf('/') + 1);
  const extension = leaf.includes('.') ? leaf.slice(leaf.lastIndexOf('.') + 1).toLowerCase() : '';
  return Boolean(
    (scheme && selector.schemes?.includes(scheme))
    || (extension && selector.extensions?.map((value) => value.replace(/^\./u, '').toLowerCase()).includes(extension))
    || (resource.mime && selector.mimeTypes?.includes(resource.mime))
    || (resource.kind && selector.kinds?.includes(resource.kind)),
  );
}

function byRank(a: ResourceEditorRegistration, b: ResourceEditorRegistration): number {
  return layerRank[b.sourceLayer ?? 'installed'] - layerRank[a.sourceLayer ?? 'installed']
    || Number(b.priority === 'default') - Number(a.priority === 'default')
    || a.id.localeCompare(b.id);
}

function readAssociations(): Record<string, QualifiedResourceEditorId> {
  try {
    const parsed = JSON.parse(localStorage.getItem(ASSOCIATIONS_KEY) ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, QualifiedResourceEditorId> : {};
  } catch {
    return {};
  }
}

function writeAssociations(value: Readonly<Record<string, QualifiedResourceEditorId>>): void {
  try { localStorage.setItem(ASSOCIATIONS_KEY, JSON.stringify(value)); } catch { /* unavailable */ }
}

export function createResourceEditorResolver(
  contributions: ContributionRegistry<PagePlatformContribution>,
  pages: PagePort,
): ResourceEditorResolver {
  const sortedCandidates = (resource: ResourceDescriptor): ResourceEditorRegistration[] => {
    const all = contributions.entries().flatMap(({ item }) => item.resourceEditors ?? []);
    // A fallback selector carries no matchers (schema-enforced mutual exclusion),
    // so `matches` never admits it here — targeted editors form a strictly
    // higher tier than default editors regardless of layer or priority.
    const targeted = all.filter((editor) => matches(editor, resource)).sort(byRank);
    const fallbacks = all.filter((editor) => editor.selector.fallback === true).sort(byRank);
    const preferred = readAssociations()[resource.canonicalId];
    // Stable sort, so an explicit user association is the only thing that can
    // lift a default editor above a targeted one.
    return [...targeted, ...fallbacks]
      .sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred));
  };

  return {
    list: sortedCandidates,
    resolve(resource) {
      return sortedCandidates(resource)[0];
    },
    async open(resource) {
      const editor = this.resolve(resource);
      if (!editor) {
        throw new PagePlatformError(
          'RESOURCE_EDITOR_NOT_FOUND',
          `no resource editor matches "${resource.uri}"`,
          { canonicalId: resource.canonicalId, uri: resource.uri },
        );
      }
      return pages.open({ typeId: editor.pageTypeId, resource });
    },
    setUserAssociation(resource, editorId) {
      const next = readAssociations();
      if (editorId) next[resource.canonicalId] = editorId;
      else delete next[resource.canonicalId];
      writeAssociations(next);
    },
  };
}
