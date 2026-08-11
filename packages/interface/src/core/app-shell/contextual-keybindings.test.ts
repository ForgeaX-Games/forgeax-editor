import { describe, expect, it } from 'bun:test';
import { createCommandsRegistry } from '../extension-foundation/commands';
import {
  createContextualKeybindings,
  matchesKeybinding,
  normalizeKeyboardEvent,
  normalizeKeybinding,
} from '../contextual-keybindings';

function keyEvent(
  key: string,
  path: readonly EventTarget[],
  init: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, cancelable: true, ...init });
  Object.defineProperty(event, 'composedPath', { value: () => path });
  return event;
}

describe('contextual keybindings', () => {
  it('resolves nested DOM scopes from child to parent', async () => {
    const commands = createCommandsRegistry();
    const called: string[] = [];
    commands.register({ id: 'child.delete', execute: () => { called.push('child'); } });
    commands.register({ id: 'parent.delete', execute: () => { called.push('parent'); } });
    const keybindings = createContextualKeybindings(commands, { platform: 'linux' });
    const parent = document.createElement('div');
    const child = document.createElement('button');
    parent.append(child);
    keybindings.registerScope(parent, 'panel');
    keybindings.registerScope(child, 'widget');
    keybindings.register({ commandId: 'parent.delete', keys: 'Delete', scope: 'panel' });
    keybindings.register({ commandId: 'child.delete', keys: 'Delete', scope: 'widget' });

    expect(keybindings.handle(keyEvent('Delete', [child, parent, document, window])).status).toBe('handled');
    await Promise.resolve();
    expect(called).toEqual(['child']);
  });

  it('claims a disabled child binding without falling back to its parent', async () => {
    const commands = createCommandsRegistry();
    let parentCalls = 0;
    commands.register({ id: 'child.delete', when: () => false, execute: () => {} });
    commands.register({ id: 'parent.delete', execute: () => { parentCalls++; } });
    const keybindings = createContextualKeybindings(commands, { platform: 'linux' });
    const parent = document.createElement('div');
    const child = document.createElement('div');
    keybindings.registerScope(parent, 'panel');
    keybindings.registerScope(child, 'widget');
    keybindings.register({ commandId: 'child.delete', keys: 'Delete', scope: 'widget' });
    keybindings.register({ commandId: 'parent.delete', keys: 'Delete', scope: 'panel' });
    const event = keyEvent('Delete', [child, parent, document, window]);

    expect(keybindings.handle(event).status).toBe('claimed-disabled');
    await Promise.resolve();
    expect(parentCalls).toBe(0);
    expect(event.defaultPrevented).toBe(true);
  });

  it('continues to the parent when the child scope does not declare the key', async () => {
    const commands = createCommandsRegistry();
    let calls = 0;
    commands.register({ id: 'parent.rename', execute: () => { calls++; } });
    const keybindings = createContextualKeybindings(commands, { platform: 'linux' });
    const parent = document.createElement('div');
    const child = document.createElement('div');
    keybindings.registerScope(parent, 'panel');
    keybindings.registerScope(child, 'widget');
    keybindings.register({ commandId: 'parent.rename', keys: 'F2', scope: 'panel' });

    expect(keybindings.handle(keyEvent('F2', [child, parent, document, window])).status).toBe('handled');
    await Promise.resolve();
    expect(calls).toBe(1);
  });

  it('passes editable and IME events through by default', () => {
    const commands = createCommandsRegistry();
    commands.register({ id: 'app.selectAll', execute: () => {} });
    const keybindings = createContextualKeybindings(commands, { platform: 'linux' });
    keybindings.register({ commandId: 'app.selectAll', keys: 'Mod+A', scope: 'application' });
    const input = document.createElement('input');

    expect(keybindings.resolve(keyEvent('a', [input, document, window], { ctrlKey: true }))).toEqual({
      status: 'passthrough',
      reason: 'editable',
    });
    expect(keybindings.resolve(keyEvent('a', [document.body, document, window], {
      ctrlKey: true,
      isComposing: true,
    }))).toEqual({ status: 'passthrough', reason: 'composition' });
  });

  it('normalizes Mod for macOS and non-macOS platforms', () => {
    expect(normalizeKeybinding('Mod+Shift+s', 'mac')).toBe('Meta+Shift+S');
    expect(normalizeKeybinding('Mod+Shift+s', 'windows')).toBe('Ctrl+Shift+S');
    const event = keyEvent('s', [document.body], { metaKey: true, shiftKey: true });
    expect(matchesKeybinding(normalizeKeyboardEvent(event, 'mac'), 'Mod+Shift+S', 'mac')).toBe(true);
    expect(matchesKeybinding(normalizeKeyboardEvent(event, 'linux'), 'Mod+Shift+S', 'linux')).toBe(false);
  });

  it('removes binding and scope registrations through cleanup', async () => {
    const commands = createCommandsRegistry();
    let parentCalls = 0;
    commands.register({ id: 'child.delete', execute: () => {} });
    commands.register({ id: 'parent.delete', execute: () => { parentCalls++; } });
    const keybindings = createContextualKeybindings(commands, { platform: 'linux' });
    const parent = document.createElement('div');
    const child = document.createElement('div');
    keybindings.registerScope(parent, 'panel');
    const removeScope = keybindings.registerScope(child, 'widget');
    const removeChildBinding = keybindings.register({
      commandId: 'child.delete',
      keys: 'Delete',
      scope: 'widget',
    });
    keybindings.register({ commandId: 'parent.delete', keys: 'Delete', scope: 'panel' });

    removeChildBinding();
    removeScope();
    expect(keybindings.handle(keyEvent('Delete', [child, parent, document, window])).status).toBe('handled');
    await Promise.resolve();
    expect(parentCalls).toBe(1);
  });
});
