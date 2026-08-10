import {
  subscribeAnimationDiagnostics,
  type AnimationDiagnostic,
  type AnimationDiagnosticListener,
} from '@forgeax/engine-animation';
import type { World } from '@forgeax/engine-ecs';
import type { RuntimeDiagnosticFact, RuntimeDiagnosticsProvider } from '@forgeax/editor-core';

const MAX_GROUPS_PER_WORLD = 128;

interface DiagnosticGroup {
  readonly code: string;
  readonly hint: string;
  readonly player: number;
  readonly targetId: string;
  readonly reason: AnimationDiagnostic['detail']['reason'];
  readonly clips: Set<number>;
  readonly channels: Set<number>;
}

export interface AnimationDiagnosticsProviderBridge {
  readonly provider: RuntimeDiagnosticsProvider;
  readonly dispose: () => void;
}

export interface AnimationDiagnosticsProviderOptions {
  readonly getActiveWorld: () => World;
  readonly subscribe?: (listener: AnimationDiagnosticListener) => () => void;
}

/** Project engine-owned animation failures without parsing or duplicating console output. */
export function createAnimationDiagnosticsProvider(
  options: AnimationDiagnosticsProviderOptions,
): AnimationDiagnosticsProviderBridge {
  const groupsBySource = new WeakMap<World, Map<string, DiagnosticGroup>>();
  const listeners = new Set<() => void>();
  const subscribe = options.subscribe ?? subscribeAnimationDiagnostics;
  const unsubscribe = subscribe((source, diagnostic) => {
    let groups = groupsBySource.get(source);
    if (groups === undefined) {
      groups = new Map();
      groupsBySource.set(source, groups);
    }
    const { player, clip, channel, targetId, reason } = diagnostic.detail;
    const key = `${player}:${targetId}:${reason}`;
    let group = groups.get(key);
    if (group === undefined) {
      if (groups.size >= MAX_GROUPS_PER_WORLD) groups.delete(groups.keys().next().value as string);
      group = {
        code: diagnostic.code,
        hint: diagnostic.hint,
        player,
        targetId,
        reason,
        clips: new Set(),
        channels: new Set(),
      };
      groups.set(key, group);
    }
    group.clips.add(clip);
    group.channels.add(channel);
    for (const listener of listeners) listener();
  });

  const provider: RuntimeDiagnosticsProvider = {
    id: 'engine-animation',
    snapshot: () => {
      const groups = groupsBySource.get(options.getActiveWorld());
      if (groups === undefined) return [];
      return [...groups.entries()].map(([id, group]) => projectGroup(id, group));
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return {
    provider,
    dispose: () => {
      unsubscribe();
      listeners.clear();
    },
  };
}

function projectGroup(id: string, group: DiagnosticGroup): RuntimeDiagnosticFact {
  const entityRef = Object.freeze({ kind: 'entity-handle', id: String(group.player) });
  const clips = Object.freeze([...group.clips]);
  const channels = Object.freeze([...group.channels]);
  return Object.freeze({
    id: `animation:${id}`,
    severity: 'warn',
    code: group.code,
    title: `Animation target ${group.targetId}`,
    message: group.hint,
    subjectRef: entityRef,
    objectRefs: Object.freeze({ entity: entityRef }),
    retryable: true,
    recoveryActions: Object.freeze(['setSelection', 'setComponent', 'query']),
    detail: Object.freeze({
      player: group.player,
      targetId: group.targetId,
      reason: group.reason,
      clips,
      channels,
      uniqueChannels: channels.length,
      recovery: Object.freeze({
        selectPlayer: Object.freeze({ operation: 'setSelection', input: { id: group.player } }),
        bindTarget: Object.freeze({ operation: 'setComponent', targetId: group.targetId }),
        inspectMountOverride: Object.freeze({ operation: 'query', targetId: group.targetId }),
      }),
      provenance: Object.freeze({ source: 'engine-animation' }),
    }),
  });
}
