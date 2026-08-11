import type { CommandsRegistry } from './extension-foundation/commands';
import type { Cleanup } from './extension-foundation/types';

export type KeybindingPlatform = 'mac' | 'windows' | 'linux';
export type KeybindingPreventDefault = 'whenHandled' | 'always' | 'never';

export const APPLICATION_KEYBINDING_SCOPE = 'application';

export interface KeybindingContext {
  readonly event: KeyboardEvent;
  readonly scopes: readonly string[];
}

export interface KeybindingContribution {
  readonly commandId: string;
  readonly keys: string | readonly string[];
  /** A registered DOM scope id, or the application fallback scope. */
  readonly scope: string;
  readonly priority?: number;
  readonly when?: (context: KeybindingContext) => boolean;
  readonly preventDefault?: KeybindingPreventDefault;
  readonly allowInEditable?: boolean;
  readonly allowDuringComposition?: boolean;
}

export interface RegisteredKeybinding extends KeybindingContribution {
  readonly registrationOrder: number;
}

export interface NormalizedKeyEvent {
  readonly key: string;
  readonly editable: boolean;
  readonly composing: boolean;
}

export type KeybindingResolution =
  | { readonly status: 'passthrough'; readonly reason: 'editable' | 'composition' }
  | { readonly status: 'unclaimed' }
  | { readonly status: 'claimed-disabled'; readonly binding: RegisteredKeybinding }
  | { readonly status: 'matched'; readonly binding: RegisteredKeybinding };

export type KeybindingHandleResult =
  | Exclude<KeybindingResolution, { readonly status: 'matched' }>
  | { readonly status: 'handled'; readonly binding: RegisteredKeybinding };

export interface ResolveKeybindingInput {
  readonly event: KeyboardEvent;
  readonly normalized: NormalizedKeyEvent;
  readonly scopes: readonly string[];
  readonly bindings: readonly RegisteredKeybinding[];
  readonly platform: KeybindingPlatform;
  readonly isCommandEnabled: (commandId: string) => boolean;
}

export interface ContextualKeybindingsApi {
  register(binding: KeybindingContribution): Cleanup;
  registerScope(element: Element, scopeId: string): Cleanup;
  resolve(event: KeyboardEvent): KeybindingResolution;
  handle(event: KeyboardEvent): KeybindingHandleResult;
  dispose(): void;
}

function normalizeKey(key: string): string {
  if (key === ' ') return 'Space';
  if (key.length === 1) return key.toUpperCase();
  const aliases: Record<string, string> = {
    Esc: 'Escape',
    Del: 'Delete',
    Left: 'ArrowLeft',
    Right: 'ArrowRight',
    Up: 'ArrowUp',
    Down: 'ArrowDown',
  };
  return aliases[key] ?? key;
}

export function detectKeybindingPlatform(): KeybindingPlatform {
  if (typeof navigator === 'undefined') return 'linux';
  const platform = navigator.platform.toLowerCase();
  if (platform.includes('mac')) return 'mac';
  if (platform.includes('win')) return 'windows';
  return 'linux';
}

export function normalizeKeybinding(keys: string, platform: KeybindingPlatform): string {
  const parts = keys.split('+').map((part) => part.trim()).filter(Boolean);
  const key = parts.pop();
  if (!key) return '';

  const modifiers = new Set<string>();
  for (const modifier of parts) {
    const lower = modifier.toLowerCase();
    if (lower === 'mod') modifiers.add(platform === 'mac' ? 'Meta' : 'Ctrl');
    else if (lower === 'cmd' || lower === 'command' || lower === 'meta') modifiers.add('Meta');
    else if (lower === 'ctrl' || lower === 'control') modifiers.add('Ctrl');
    else if (lower === 'alt' || lower === 'option') modifiers.add('Alt');
    else if (lower === 'shift') modifiers.add('Shift');
  }

  const ordered = ['Ctrl', 'Meta', 'Alt', 'Shift'].filter((modifier) => modifiers.has(modifier));
  return [...ordered, normalizeKey(key)].join('+');
}

export function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return true;
  }
  return target.closest('[contenteditable]:not([contenteditable="false"]),[role="textbox"]') !== null;
}

export function normalizeKeyboardEvent(
  event: KeyboardEvent,
  platform: KeybindingPlatform = detectKeybindingPlatform(),
): NormalizedKeyEvent {
  const modifiers = [
    event.ctrlKey ? 'Ctrl' : '',
    event.metaKey ? 'Meta' : '',
    event.altKey ? 'Alt' : '',
    event.shiftKey ? 'Shift' : '',
  ].filter(Boolean);
  return {
    key: [...modifiers, normalizeKey(event.key)].join('+'),
    editable: isEditableEventTarget(event.composedPath()[0] ?? event.target),
    composing: event.isComposing || event.keyCode === 229,
  };
}

export function matchesKeybinding(
  event: NormalizedKeyEvent,
  keys: string,
  platform: KeybindingPlatform,
): boolean {
  return event.key === normalizeKeybinding(keys, platform);
}

function bindingMatches(
  binding: RegisteredKeybinding,
  normalized: NormalizedKeyEvent,
  platform: KeybindingPlatform,
): boolean {
  const keys = typeof binding.keys === 'string' ? [binding.keys] : binding.keys;
  return keys.some((key) => matchesKeybinding(normalized, key, platform));
}

export function resolveKeybinding(input: ResolveKeybindingInput): KeybindingResolution {
  const scopeOrder = [...input.scopes, APPLICATION_KEYBINDING_SCOPE];
  const context: KeybindingContext = { event: input.event, scopes: input.scopes };

  for (const scope of scopeOrder) {
    const candidates = input.bindings
      .filter((binding) => binding.scope === scope)
      .filter((binding) => bindingMatches(binding, input.normalized, input.platform))
      .filter((binding) => !binding.when || binding.when(context))
      .filter((binding) => !input.normalized.editable || binding.allowInEditable)
      .filter((binding) => !input.normalized.composing || binding.allowDuringComposition)
      .sort((a, b) =>
        (b.priority ?? 0) - (a.priority ?? 0)
        || b.registrationOrder - a.registrationOrder,
      );
    const binding = candidates[0];
    if (!binding) continue;
    if (!input.isCommandEnabled(binding.commandId)) {
      return { status: 'claimed-disabled', binding };
    }
    return { status: 'matched', binding };
  }

  if (input.normalized.composing) return { status: 'passthrough', reason: 'composition' };
  if (input.normalized.editable) return { status: 'passthrough', reason: 'editable' };
  return { status: 'unclaimed' };
}

export function createContextualKeybindings(
  commands: CommandsRegistry,
  options: {
    readonly platform?: KeybindingPlatform;
    readonly onCommandError?: (error: unknown, commandId: string) => void;
  } = {},
): ContextualKeybindingsApi {
  const platform = options.platform ?? detectKeybindingPlatform();
  const bindings = new Set<RegisteredKeybinding>();
  const scopes = new WeakMap<Element, string>();
  let registrationOrder = 0;

  const scopePath = (event: KeyboardEvent): string[] => {
    const result: string[] = [];
    for (const target of event.composedPath()) {
      if (!(target instanceof Element)) continue;
      const scopeId = scopes.get(target);
      if (scopeId && !result.includes(scopeId)) result.push(scopeId);
    }
    return result;
  };

  const resolve = (event: KeyboardEvent): KeybindingResolution => {
    const normalized = normalizeKeyboardEvent(event, platform);
    return resolveKeybinding({
      event,
      normalized,
      scopes: scopePath(event),
      bindings: Array.from(bindings),
      platform,
      isCommandEnabled(commandId) {
        const command = commands.get(commandId);
        if (!command) return false;
        try {
          return !command.when || command.when();
        } catch {
          return false;
        }
      },
    });
  };

  return {
    register(binding) {
      const registered = { ...binding, registrationOrder: registrationOrder++ };
      bindings.add(registered);
      return () => { bindings.delete(registered); };
    },
    registerScope(element, scopeId) {
      scopes.set(element, scopeId);
      return () => {
        if (scopes.get(element) === scopeId) scopes.delete(element);
      };
    },
    resolve,
    handle(event) {
      const result = resolve(event);
      if (result.status !== 'matched' && result.status !== 'claimed-disabled') return result;

      if (result.binding.preventDefault !== 'never') event.preventDefault();
      event.stopImmediatePropagation();
      if (result.status === 'claimed-disabled') return result;

      void commands.execute(result.binding.commandId).catch((error) => {
        options.onCommandError?.(error, result.binding.commandId);
      });
      return { status: 'handled', binding: result.binding };
    },
    dispose() {
      bindings.clear();
    },
  };
}
