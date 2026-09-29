// inline-create-resolve — map a post-create folder path to a visible CB row.

import type { CBFolder, CBViewItem } from './types';

export interface PendingInlineFolderCreate {
  readonly path: string;
  readonly startedAt: number;
}

export function resolveInlineFolderCreateItem(
  path: string,
  viewItems: readonly CBViewItem[],
): CBFolder | undefined {
  return viewItems.find((row): row is CBFolder => row.type === 'folder' && row.path === path);
}
