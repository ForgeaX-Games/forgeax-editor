import type {
  AppHost,
  CommandDescriptor,
  KeybindingHandleResult,
  KeybindingRegistration,
  RegisteredKeybinding,
} from '@forgeax/app-shell/application';
import { createApplicationShortcutRegistry } from '@forgeax/app-shell/application';

export type TestApplicationHost = AppHost;

function normalizedKey(event: KeyboardEvent): string {
  const modifiers = [
    event.ctrlKey ? 'Ctrl' : '',
    event.metaKey ? 'Meta' : '',
    event.altKey ? 'Alt' : '',
    event.shiftKey ? 'Shift' : '',
  ].filter(Boolean);
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  return [...modifiers, key].join('+');
}

function bindingMatches(binding: KeybindingRegistration, event: KeyboardEvent): boolean {
  const candidates = typeof binding.keys === 'string' ? [binding.keys] : binding.keys;
  return candidates.some((candidate) =>
    candidate.replace('Mod+', event.metaKey ? 'Meta+' : 'Ctrl+') === normalizedKey(event),
  );
}

/** Minimal package-test double; product bootstrap and defaults stay out of package tests. */
export function createTestApplicationHost(): { readonly host: TestApplicationHost } {
  const commands = new Map<string, CommandDescriptor>();
  const bindings = new Set<RegisteredKeybinding>();
  const scopes = new WeakMap<Element, string>();
  let registrationOrder = 0;

  const commandApi: AppHost['commands'] = {
    register(command) {
      commands.set(command.id, command);
      return () => {
        if (commands.get(command.id) === command) commands.delete(command.id);
      };
    },
    async execute<Result>(id: string, args?: unknown): Promise<Result> {
      const command = commands.get(id);
      if (!command) throw new Error(`Unknown test command: ${id}`);
      if (command.when && !command.when()) throw new Error(`Disabled test command: ${id}`);
      return await command.execute(args) as Result;
    },
  };

  const matchBinding = (event: KeyboardEvent): RegisteredKeybinding | undefined => {
    const activeScopes = event.composedPath()
      .filter((target): target is Element => target instanceof Element)
      .map((element) => scopes.get(element))
      .filter((scope): scope is string => scope !== undefined);
    return [...bindings]
      .filter((candidate) => activeScopes.includes(candidate.scope))
      .filter((candidate) => bindingMatches(candidate, event))
      .filter((candidate) => !candidate.when || candidate.when({ event, scopes: activeScopes }))
      .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))[0];
  };

  const isCommandEnabled = (commandId: string): boolean => {
    const command = commands.get(commandId);
    if (!command) return false;
    return !command.when || command.when();
  };

  const keybindingApi: AppHost['keybindings'] = {
    register(binding) {
      const registered: RegisteredKeybinding = {
        ...binding,
        registrationOrder: registrationOrder++,
      };
      bindings.add(registered);
      return () => {
        bindings.delete(registered);
      };
    },
    registerScope(element, scopeId) {
      scopes.set(element, scopeId);
      return () => {
        if (scopes.get(element) === scopeId) scopes.delete(element);
      };
    },
    resolve(event) {
      const binding = matchBinding(event);
      if (!binding) return { status: 'unclaimed' };
      if (!isCommandEnabled(binding.commandId)) {
        return { status: 'claimed-disabled', binding };
      }
      return { status: 'matched', binding };
    },
    handle(event): KeybindingHandleResult {
      const result = keybindingApi.resolve(event);
      if (result.status !== 'matched' && result.status !== 'claimed-disabled') {
        return result;
      }
      if (result.binding.preventDefault !== 'never') event.preventDefault();
      event.stopImmediatePropagation();
      if (result.status === 'claimed-disabled') return result;
      void commandApi.execute(result.binding.commandId);
      return { status: 'handled', binding: result.binding };
    },
    dispose() {
      bindings.clear();
    },
  };

  return {
    host: {
      commands: commandApi,
      keybindings: keybindingApi,
      shortcuts: createApplicationShortcutRegistry(),
    } as unknown as TestApplicationHost,
  };
}
