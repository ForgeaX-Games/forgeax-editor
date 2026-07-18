// packages/interface/src/core/extension-foundation/commands.ts
import type { Cleanup } from './types';
import { ExtensionConflictError } from './errors';

export interface CommandDescriptor {
  readonly id: string;
  readonly title?: string;
  readonly keybinding?: string;
  readonly when?: () => boolean;
  readonly execute: (args?: unknown) => unknown | Promise<unknown>;
}

export interface CommandsRegistry {
  register(cmd: CommandDescriptor): Cleanup;
  execute<R = unknown>(id: string, args?: unknown): Promise<R>;
  get(id: string): CommandDescriptor | undefined;
  list(): readonly CommandDescriptor[];
  onDidRegister(listener: (id: string) => void): Cleanup;
}

export function createCommandsRegistry(): CommandsRegistry {
  const entries = new Map<string, CommandDescriptor>();
  const didRegisterListeners = new Set<(id: string) => void>();

  return {
    register(cmd) {
      if (entries.has(cmd.id)) {
        throw new ExtensionConflictError({
          id: cmd.id,
          subRegistryName: 'commands',
          existingOwner: '(existing command)',
          newOwner: '(new command)',
        });
      }
      entries.set(cmd.id, cmd);
      for (const l of Array.from(didRegisterListeners)) {
        try { l(cmd.id); } catch (err) {
          console.error('[extension-foundation] onDidRegister listener threw', err);
        }
      }
      return () => { entries.delete(cmd.id); };
    },
    async execute<R = unknown>(id: string, args?: unknown): Promise<R> {
      const cmd = entries.get(id);
      if (!cmd) throw new Error(`[extension-foundation] command "${id}" not found`);
      if (cmd.when && !cmd.when()) throw new Error(`[extension-foundation] command "${id}" blocked by "when" predicate`);
      return (await cmd.execute(args)) as R;
    },
    get(id) { return entries.get(id); },
    list() { return Array.from(entries.values()); },
    onDidRegister(listener) {
      didRegisterListeners.add(listener);
      return () => { didRegisterListeners.delete(listener); };
    },
  };
}
