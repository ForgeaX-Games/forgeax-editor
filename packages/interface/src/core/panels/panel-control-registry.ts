import type { Cleanup } from '../extension-foundation/types';
import type { PanelControlContribution, PanelControlsApi } from './types';

interface Entry {
  readonly owner: string;
  readonly controls: readonly PanelControlContribution[];
}

export interface PanelControlRegistry extends PanelControlsApi {
  contribute(owner: string, controls: readonly PanelControlContribution[]): Cleanup;
}

export function createPanelControlRegistry(): PanelControlRegistry {
  const entries: Entry[] = [];
  const listeners = new Set<() => void>();
  let version = 0;

  const emit = (): void => {
    version++;
    for (const listener of [...listeners]) listener();
  };

  // Batch-deferred notification: data mutations (push/splice) happen
  // immediately so reads (list/get) always return fresh data, but listener
  // notifications are deferred to a microtask. This avoids triggering
  // forceStoreRerender (useSyncExternalStore) during React 19's commit
  // phase, which otherwise causes "Maximum update depth exceeded".
  let emitScheduled = false;
  const scheduleEmit = (): void => {
    if (emitScheduled) return;
    emitScheduled = true;
    queueMicrotask(() => {
      emitScheduled = false;
      emit();
    });
  };

  const list = (): readonly PanelControlContribution[] => entries.flatMap((entry) => entry.controls);

  return {
    contribute(owner, controls) {
      const entry: Entry = { owner, controls };
      entries.push(entry);
      scheduleEmit();
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        const index = entries.indexOf(entry);
        if (index >= 0) entries.splice(index, 1);
        scheduleEmit();
      };
    },
    get(id) {
      return list().find((control) => control.id === id);
    },
    list,
    onChange(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    version() {
      return version;
    },
  };
}
