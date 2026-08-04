import type { AppHost } from './app-shell/types';
import type { ResourceDescriptor } from '@forgeax/types';

let current: AppHost | null = null;

export function installPageNavigation(host: AppHost): () => void {
  current = host;
  return () => { if (current === host) current = null; };
}

export async function openExtensionPage(extensionId: string): Promise<void> {
  if (!current) throw new Error('Page host is not ready');
  const page = [...current.pageRegistry.getSnapshot().pageTypes.entries()]
    .find(([, resolved]) => resolved.owner === extensionId && resolved.status === 'available');
  if (!page) throw new Error(`extension "${extensionId}" contributes no available singleton page`);
  const [typeId, resolved] = page;
  if (resolved.definition.cardinality !== 'singleton') {
    throw new Error(`extension "${extensionId}" has no default singleton page`);
  }
  await current.pages.open({ typeId });
}

export async function openPageType(typeId: string): Promise<void> {
  if (!current) throw new Error('Page host is not ready');
  await current.pages.open({ typeId: typeId as Parameters<AppHost['pages']['open']>[0]['typeId'] });
}

export async function openResource(resource: ResourceDescriptor): Promise<void> {
  if (!current) throw new Error('Page host is not ready');
  await current.resourceEditors.open(resource);
}
