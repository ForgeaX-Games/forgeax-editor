import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, renderHook } from '@testing-library/react';
import { createAppHost } from '../core/app-shell';
import { useGlobalShortcuts } from './global-shortcuts';

try { GlobalRegistrator.register(); } catch { /* shared DOM test environment */ }

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('global shortcut capture integration', () => {
  it('runs contextual resolution before legacy shortcuts in the single listener', async () => {
    const { host } = createAppHost();
    const widget = document.createElement('button');
    document.body.append(widget);
    let calls = 0;
    host.commands.register({ id: 'widget.rename', execute: () => { calls += 1; } });
    host.keybindings.registerScope(widget, 'test.widget');
    host.keybindings.register({
      keys: 'F2',
      commandId: 'widget.rename',
      scope: 'test.widget',
    });

    renderHook(() => useGlobalShortcuts(host.keybindings));
    const event = new KeyboardEvent('keydown', {
      key: 'F2',
      bubbles: true,
      cancelable: true,
    });
    widget.dispatchEvent(event);
    await Promise.resolve();

    expect(calls).toBe(1);
    expect(event.defaultPrevented).toBe(true);
  });
});
