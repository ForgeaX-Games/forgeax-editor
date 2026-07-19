// packages/interface/src/core/extension-foundation/contribution-registry.ts
//
// Ordered, owner-tagged contribution store — ADR 0025 M2's SSOT for what
// extensions contribute to the shell. Domain-agnostic: T is opaque here; the
// app-shell layer folds entries() into a derived PanelRenderers snapshot
// (see core/app-shell/derive-panel-renderers.ts).
//
// Removal semantics: a contribution's Cleanup deletes its entry and bumps the
// version — consumers re-fold from entries(). This replaces the previous
// prev-value undo-closure approach (foundation-panels mergePanels), whose
// restore was order-sensitive; re-folding is not.
import type { Cleanup } from './types';

export interface ContributionEntry<T> {
  readonly owner: string;
  readonly item: T;
}

export interface ContributionRegistry<T> {
  /** Append an owner-tagged entry (declaration order preserved). Returns an
   *  idempotent Cleanup that removes exactly this entry. */
  contribute(owner: string, item: T): Cleanup;
  /** Live entries in contribution order. Fresh array per call. */
  entries(): ReadonlyArray<ContributionEntry<T>>;
  /** Coarse-grained change signal — fires after any add/remove. */
  onChange(listener: () => void): () => void;
  /** Monotonic counter; bumps on every add/remove. Memo key for derived views. */
  version(): number;
}

export function createContributionRegistry<T>(): ContributionRegistry<T> {
  const list: Array<ContributionEntry<T>> = [];
  const listeners = new Set<() => void>();
  let ver = 0;
  const bump = (): void => {
    ver++;
    // Snapshot before iterating — a listener may unsubscribe itself.
    for (const l of [...listeners]) l();
  };
  return {
    contribute(owner, item) {
      const entry: ContributionEntry<T> = { owner, item };
      list.push(entry);
      bump();
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        const i = list.indexOf(entry);
        if (i >= 0) list.splice(i, 1);
        bump();
      };
    },
    entries() {
      return [...list];
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version() {
      return ver;
    },
  };
}
