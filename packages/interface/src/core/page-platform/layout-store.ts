import type { QualifiedPageTypeId } from '@forgeax/types';
import type { SerializedDockview } from 'dockview';

export interface PageLayoutIdentity {
  readonly pageTypeId: QualifiedPageTypeId;
  readonly layoutVersion: number;
}

export interface StoredPageLayout {
  readonly schemaVersion: 1;
  readonly pageTypeId: QualifiedPageTypeId;
  readonly layoutVersion: number;
  readonly layout: SerializedDockview;
}

export interface PageLayoutStore {
  load(key: string, expected: PageLayoutIdentity): SerializedDockview | null;
  save(key: string, identity: PageLayoutIdentity, layout: SerializedDockview): void;
  remove(key: string): void;
}

function parseStoredPageLayout(raw: string): StoredPageLayout | null {
  try {
    const value = JSON.parse(raw) as Partial<StoredPageLayout>;
    if (
      value.schemaVersion !== 1
      || typeof value.pageTypeId !== 'string'
      || !Number.isInteger(value.layoutVersion)
      || !value.layout
      || typeof value.layout !== 'object'
    ) return null;
    return value as StoredPageLayout;
  } catch {
    return null;
  }
}

export const pageLayoutStore: PageLayoutStore = {
  load(key, expected) {
    let raw: string | null = null;
    try { raw = localStorage.getItem(key); } catch { return null; }
    if (!raw) return null;
    const stored = parseStoredPageLayout(raw);
    if (
      !stored
      || stored.pageTypeId !== expected.pageTypeId
      || stored.layoutVersion !== expected.layoutVersion
    ) {
      this.remove(key);
      return null;
    }
    return stored.layout;
  },
  save(key, identity, layout) {
    const stored: StoredPageLayout = {
      schemaVersion: 1,
      pageTypeId: identity.pageTypeId,
      layoutVersion: identity.layoutVersion,
      layout,
    };
    try { localStorage.setItem(key, JSON.stringify(stored)); } catch { /* quota */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* unavailable */ }
  },
};
