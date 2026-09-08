import type {
  GameActionDef,
  GameProjectionRegistrar,
  GameProjectionValue,
  GameReadDef,
} from '@forgeax/engine-app';

export interface PlayGameplayDescriptor {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly argsSchema?: GameActionDef['argsSchema'];
}

export type PlayGameplayResult =
  | { readonly ok: true; readonly data?: GameProjectionValue }
  | { readonly ok: false; readonly error: { readonly code: string; readonly hint: string } };

export interface PlayGameplayProjection {
  readonly registrar: GameProjectionRegistrar;
  describe(): { readonly actions: readonly PlayGameplayDescriptor[]; readonly reads: readonly PlayGameplayDescriptor[] };
  run(id: string, args: GameProjectionValue): Promise<PlayGameplayResult>;
  read(id: string): Promise<PlayGameplayResult>;
}

function serialise(value: unknown):
  | { readonly ok: true; readonly value?: GameProjectionValue }
  | { readonly ok: false; readonly cause: string } {
  if (value === undefined) return { ok: true };
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return { ok: true };
    return { ok: true, value: JSON.parse(json) as GameProjectionValue };
  } catch (cause) {
    return { ok: false, cause: String(cause) };
  }
}

function descriptor(def: GameActionDef | GameReadDef): PlayGameplayDescriptor {
  return {
    id: def.id,
    title: def.title,
    ...(def.description === undefined ? {} : { description: def.description }),
    ...('argsSchema' in def && def.argsSchema !== undefined ? { argsSchema: def.argsSchema } : {}),
  };
}

function projectionError(code: string, hint: string): PlayGameplayResult {
  return { ok: false, error: { code, hint } };
}

/**
 * Create the disposable iframe's producer-owned projection registry.
 * Registrations live with the iframe World and are never exposed as raw ECS
 * objects to the parent Editor realm.
 */
export function createPlayGameplayProjection(): PlayGameplayProjection {
  const actions = new Map<string, GameActionDef>();
  const reads = new Map<string, GameReadDef>();

  const register = (kind: 'action' | 'read', def: GameActionDef | GameReadDef): (() => void) => {
    if (actions.has(def.id) || reads.has(def.id)) {
      throw new Error(`play: duplicate projection id '${def.id}'`);
    }
    if (kind === 'action') actions.set(def.id, def as GameActionDef);
    else reads.set(def.id, def as GameReadDef);
    return () => {
      if (kind === 'action' && actions.get(def.id) === def) actions.delete(def.id);
      if (kind === 'read' && reads.get(def.id) === def) reads.delete(def.id);
    };
  };

  const registrar: GameProjectionRegistrar = {
    registerAction: (def) => register('action', def),
    registerRead: (def) => register('read', def),
  };

  return {
    registrar,
    describe: () => ({
      actions: [...actions.values()].map(descriptor).sort((a, b) => a.id.localeCompare(b.id)),
      reads: [...reads.values()].map(descriptor).sort((a, b) => a.id.localeCompare(b.id)),
    }),
    async run(id, args) {
      const actionDef = actions.get(id);
      if (actionDef === undefined) return projectionError('unknown-game-projection', `no registered game action named "${id}"`);
      try {
        const result = serialise(await actionDef.run(args));
        return result.ok
          ? { ok: true, ...(result.value === undefined ? {} : { data: result.value }) }
          : projectionError('game-action-failed', `game action "${id}" returned non-serializable data: ${result.cause}`);
      } catch (cause) {
        return projectionError('game-action-failed', `game action "${id}" failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    },
    async read(id) {
      const def = reads.get(id);
      if (def === undefined) return projectionError('unknown-game-projection', `no registered game read named "${id}"`);
      try {
        const result = serialise(await def.read());
        return result.ok
          ? { ok: true, ...(result.value === undefined ? {} : { data: result.value }) }
          : projectionError('game-read-failed', `game read "${id}" returned non-serializable data: ${result.cause}`);
      } catch (cause) {
        return projectionError('game-read-failed', `game read "${id}" failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    },
  };
}
