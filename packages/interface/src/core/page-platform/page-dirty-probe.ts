// page-dirty-probe — optional host/extension hook for tab dirty markers.
//
// Interface stays editor-agnostic: extensions register a probe that knows how
// to read their staging buffers (e.g. Material Instance).

import type { ResourceDescriptor } from '@forgeax/types';

export interface PageDirtyProbeTarget {
  readonly encodedKey: string;
  readonly typeId: string;
  readonly resource?: ResourceDescriptor;
}

export interface PageDirtyProbe {
  isDirty(page: PageDirtyProbeTarget): boolean;
  subscribe(listener: () => void): () => void;
}

let probe: PageDirtyProbe | null = null;

export function registerPageDirtyProbe(next: PageDirtyProbe | null): () => void {
  probe = next;
  return () => {
    if (probe === next) probe = null;
  };
}

export function isPageDirty(page: PageDirtyProbeTarget): boolean {
  return probe?.isDirty(page) === true;
}

export function subscribePageDirty(listener: () => void): () => void {
  if (!probe) return () => {};
  return probe.subscribe(listener);
}
