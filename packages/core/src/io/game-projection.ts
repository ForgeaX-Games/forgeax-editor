// io/game-projection.ts — ephemeral game-owned action/read projection registry.
//
// A game bootstrap registers Play-only capabilities through the host context. The
// editor only discovers/invokes/reads those closures; it does not import a game
// module, know a game state's variants, or obtain a raw World. The registry is
// one-run state and is cleared before the play World is dropped.
//
// This is deliberately distinct from the authoring operation catalog:
// - game actions have no document inverse, undo entry, scene-pack mutation, or ledger;
// - game reads are serializable snapshots, not live world handles;
// - the producer (game bootstrap) owns every ID, schema, and semantic body.

import type {
  GameActionDef,
  GameProjectionRegistrar as EngineGameProjectionRegistrar,
  GameProjectionValue as EngineGameProjectionValue,
  GameReadDef,
} from '@forgeax/engine-app';
import type { CommandError } from '../types';
import { validate as validateArgs } from './args-schema';
import type { ArgsSchema } from './catalog';

// The producer-owned contract lives in engine-app's BootstrapContext. Re-export
// aliases here solely so the Gateway surface stays self-describing from editor-core
// without maintaining a second action/schema vocabulary.
export type GameProjectionValue = EngineGameProjectionValue;
export type GameActionRegistration = GameActionDef;
export type GameReadRegistration = GameReadDef;

export interface GameActionDescriptor {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly argsSchema: ArgsSchema | null;
}

export interface GameReadDescriptor {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
}

export type GameProjectionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: CommandError };

export type GameProjectionRegistrar = EngineGameProjectionRegistrar;

function fail(code: CommandError['code'], hint: string): GameProjectionResult<never> {
  return { ok: false, error: { code, hint } };
}

function isProjectionValue(value: unknown, seen = new Set<unknown>()): value is GameProjectionValue {
  if (value === null) return true;
  switch (typeof value) {
    case 'boolean':
    case 'number':
    case 'string':
      return true;
    case 'object':
      if (seen.has(value)) return false;
      seen.add(value);
      if (Array.isArray(value)) return value.every((item) => isProjectionValue(item, seen));
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
      return Object.values(value as Record<string, unknown>).every((item) => isProjectionValue(item, seen));
    default:
      return false;
  }
}

/**
 * One ephemeral capability registry for a single assembled Play run. Its public
 * registrar is passed to game bootstrap; `clear()` invalidates all closures before
 * Stop releases the play world.
 */
export class GameProjectionRegistry {
  private readonly actions = new Map<string, GameActionRegistration>();
  private readonly reads = new Map<string, GameReadRegistration>();
  private closed = false;

  readonly registrar: GameProjectionRegistrar = {
    registerAction: (def) => this.registerAction(def),
    registerRead: (def) => this.registerRead(def),
  };

  private registerAction(def: GameActionRegistration): () => void {
    this.assertOpen();
    this.assertDefinition(def, 'action');
    if (this.actions.has(def.id) || this.reads.has(def.id)) {
      throw new Error(`game projection id conflict: ${def.id}`);
    }
    this.actions.set(def.id, def);
    return () => this.actions.get(def.id) === def && this.actions.delete(def.id);
  }

  private registerRead(def: GameReadRegistration): () => void {
    this.assertOpen();
    this.assertDefinition(def, 'read');
    if (this.reads.has(def.id) || this.actions.has(def.id)) {
      throw new Error(`game projection id conflict: ${def.id}`);
    }
    this.reads.set(def.id, def);
    return () => this.reads.get(def.id) === def && this.reads.delete(def.id);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('game projection registrar is closed');
  }

  private assertDefinition(def: { id: string; title: string }, kind: string): void {
    if (typeof def.id !== 'string' || def.id.trim() === '') {
      throw new Error(`game ${kind} id must be a non-empty string`);
    }
    if (typeof def.title !== 'string' || def.title.trim() === '') {
      throw new Error(`game ${kind} title must be a non-empty string`);
    }
  }

  listActions(): readonly GameActionDescriptor[] {
    return [...this.actions.values()]
      .map((def) => ({
        id: def.id,
        title: def.title,
        ...(def.description !== undefined ? { description: def.description } : {}),
        argsSchema: def.argsSchema ?? null,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  listReads(): readonly GameReadDescriptor[] {
    return [...this.reads.values()]
      .map((def) => ({
        id: def.id,
        title: def.title,
        ...(def.description !== undefined ? { description: def.description } : {}),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async invokeAction(id: string, args: unknown): Promise<GameProjectionResult<undefined>> {
    if (this.closed) return fail('game-projection-unavailable', 'game projections are unavailable because Play is not active');
    const action = this.actions.get(id);
    if (!action) return fail('unknown-game-projection', `no registered game action named "${id}"`);
    if (action.argsSchema) {
      const validation = validateArgs(action.argsSchema, args);
      if (!validation.ok) {
        const first = validation.errors[0]!;
        return fail('INVALID_ARGS', `game action "${id}" has invalid args at ${first.path}: ${first.message}`);
      }
    }
    if (!isProjectionValue(args)) {
      return fail('INVALID_ARGS', `game action "${id}" args must be JSON-shaped data`);
    }
    try {
      await action.run(args);
      return { ok: true, value: undefined };
    } catch (error) {
      const hint = error instanceof Error ? error.message : String(error);
      return fail('game-action-failed', `game action "${id}" failed: ${hint}`);
    }
  }

  async readState(id: string): Promise<GameProjectionResult<GameProjectionValue>> {
    if (this.closed) return fail('game-projection-unavailable', 'game projections are unavailable because Play is not active');
    const read = this.reads.get(id);
    if (!read) return fail('unknown-game-projection', `no registered game read named "${id}"`);
    try {
      const value = await read.read();
      if (!isProjectionValue(value)) {
        return fail('game-read-failed', `game read "${id}" returned non-serializable data`);
      }
      return { ok: true, value };
    } catch (error) {
      const hint = error instanceof Error ? error.message : String(error);
      return fail('game-read-failed', `game read "${id}" failed: ${hint}`);
    }
  }

  clear(): void {
    if (this.closed) return;
    this.closed = true;
    this.actions.clear();
    this.reads.clear();
  }
}
