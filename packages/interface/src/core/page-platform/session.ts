import {
  decodePageKey,
  encodePageKey,
  type PageKey,
} from '@forgeax/types';
import type {
  PageCloseDecision,
  PageCloseReason,
  PageController,
  PageInstance,
  PageOpenRequest,
  PagePort,
  PageRegistry,
  PageSessionSnapshot,
} from './types';
import { PagePlatformError } from './types';

interface SessionEntry {
  readonly instance: PageInstance;
  readonly controller: PageController;
}

export interface PageSession extends PagePort {
  closeOwnedBy(owner: string, reason?: PageCloseReason, decision?: PageCloseDecision): Promise<void>;
  dispose(): Promise<void>;
}

export interface CreatePageSessionOptions {
  readonly createInstanceId?: () => string;
  readonly now?: () => number;
}

const inertController: PageController = {
  prepareClose: () => ({ status: 'ready' }),
  dispose: () => undefined,
};

function normalizeKey(key: PageKey | string): PageKey {
  return typeof key === 'string' ? decodePageKey(key) : key;
}

export function createPageSession(
  registry: PageRegistry,
  options: CreatePageSessionOptions = {},
): PageSession {
  const createInstanceId = options.createInstanceId ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, SessionEntry>();
  const listeners = new Set<() => void>();
  let generation = 0;
  let activeKey: string | undefined;
  let snapshot: PageSessionSnapshot = { generation, instances: [] };

  const publish = (): void => {
    generation++;
    snapshot = {
      generation,
      ...(activeKey ? { activeKey } : {}),
      instances: [...entries.values()].map((entry) => entry.instance),
    };
    for (const listener of [...listeners]) listener();
  };

  const requireEntry = (key: PageKey | string): { encoded: string; entry: SessionEntry } => {
    const normalized = normalizeKey(key);
    const encoded = encodePageKey(normalized);
    const entry = entries.get(encoded);
    if (!entry) {
      throw new PagePlatformError('PAGE_INSTANCE_NOT_FOUND', `page instance "${encoded}" is not open`, { key: encoded });
    }
    return { encoded, entry };
  };

  const resolvePreparation = async (
    entry: SessionEntry,
    reason: PageCloseReason,
    decision?: PageCloseDecision,
  ): Promise<void> => {
    const preparation = await entry.controller.prepareClose(reason);
    if (preparation.status === 'ready') return;
    if (preparation.status === 'vetoed') {
      throw new PagePlatformError('PAGE_CLOSE_VETOED', preparation.message ?? 'page refused to close', {
        key: entry.instance.encodedKey,
        reason,
      });
    }
    if (!decision || decision === 'cancel') {
      throw new PagePlatformError(
        'PAGE_CLOSE_REQUIRES_DECISION',
        preparation.message ?? 'page has unsaved changes',
        { key: entry.instance.encodedKey, reason },
      );
    }
    if (decision === 'save') {
      if (!entry.controller.save) {
        throw new PagePlatformError('PAGE_CLOSE_VETOED', 'page cannot save its dirty state', {
          key: entry.instance.encodedKey,
          reason,
        });
      }
      await entry.controller.save();
    } else {
      if (!entry.controller.discard) {
        throw new PagePlatformError('PAGE_CLOSE_VETOED', 'page cannot discard its dirty state', {
          key: entry.instance.encodedKey,
          reason,
        });
      }
      await entry.controller.discard();
    }
  };

  const session: PageSession = {
    async open(request: PageOpenRequest): Promise<PageKey> {
      const resolved = registry.get(request.typeId);
      if (!resolved) {
        throw new PagePlatformError('PAGE_TYPE_NOT_FOUND', `page type "${request.typeId}" is not registered`, {
          typeId: request.typeId,
        });
      }
      if (resolved.status === 'unavailable') {
        throw new PagePlatformError('PAGE_TYPE_UNAVAILABLE', `page type "${request.typeId}" is unavailable`, {
          typeId: request.typeId,
          reason: resolved.reason,
          missingPanelTypeIds: resolved.missingPanelTypeIds,
        });
      }

      let key: PageKey;
      if (resolved.definition.cardinality === 'singleton') {
        if (request.resource || request.instanceId) {
          throw new PagePlatformError('PAGE_CARDINALITY_MISMATCH', 'singleton page does not accept resource or instance identity');
        }
        key = { cardinality: 'singleton', typeId: request.typeId };
      } else if (resolved.definition.cardinality === 'resource') {
        if (!request.resource || request.instanceId) {
          throw new PagePlatformError('PAGE_CARDINALITY_MISMATCH', 'resource page requires exactly one resource identity');
        }
        key = { cardinality: 'resource', typeId: request.typeId, resourceId: request.resource.canonicalId };
      } else {
        if (request.resource) {
          throw new PagePlatformError('PAGE_CARDINALITY_MISMATCH', 'multi-instance page does not accept a resource identity');
        }
        key = {
          cardinality: 'multi-instance',
          typeId: request.typeId,
          instanceId: request.instanceId ?? createInstanceId(),
        };
      }

      const encoded = encodePageKey(key);
      if (entries.has(encoded)) {
        if (activeKey !== encoded) {
          activeKey = encoded;
          publish();
        }
        return key;
      }

      const context = request.context ?? {};
      const controller = await resolved.definition.createController?.({
        key,
        context,
        ...(request.resource ? { resource: request.resource } : {}),
      }) ?? inertController;
      const instance: PageInstance = {
        key,
        encodedKey: encoded,
        typeId: request.typeId,
        context,
        ...(request.resource ? { resource: request.resource } : {}),
        openedAt: now(),
        closable: resolved.definition.closable !== false,
      };
      entries.set(encoded, { instance, controller });
      activeKey = encoded;
      publish();
      return key;
    },

    async focus(key): Promise<void> {
      const { encoded } = requireEntry(key);
      if (activeKey === encoded) return;
      activeKey = encoded;
      publish();
    },

    async close(key, request = {}): Promise<void> {
      const { encoded, entry } = requireEntry(key);
      const reason = request.reason ?? 'user';
      if (!entry.instance.closable && reason === 'user') {
        throw new PagePlatformError('PAGE_CLOSE_VETOED', 'page is permanent and cannot be closed', { key: encoded });
      }
      await resolvePreparation(entry, reason, request.decision);
      await entry.controller.dispose();
      entries.delete(encoded);
      if (activeKey === encoded) activeKey = [...entries.keys()].at(-1);
      publish();
    },

    getSnapshot(): PageSessionSnapshot {
      return snapshot;
    },

    subscribe(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async closeOwnedBy(owner, reason = 'extension-disabled', decision): Promise<void> {
      const owned = [...entries.values()].filter((entry) => registry.ownerOf(entry.instance.typeId) === owner);
      for (const entry of owned) await resolvePreparation(entry, reason, decision);
      for (const entry of owned) await entry.controller.dispose();
      if (owned.length === 0) return;
      const ownedKeys = new Set(owned.map((entry) => entry.instance.encodedKey));
      for (const key of ownedKeys) entries.delete(key);
      if (activeKey && ownedKeys.has(activeKey)) activeKey = [...entries.keys()].at(-1);
      publish();
    },

    async dispose(): Promise<void> {
      const all = [...entries.values()];
      for (const entry of all) await resolvePreparation(entry, 'host-dispose', 'discard');
      for (const entry of all) await entry.controller.dispose();
      entries.clear();
      activeKey = undefined;
      if (all.length > 0) publish();
      listeners.clear();
    },
  };

  return session;
}
