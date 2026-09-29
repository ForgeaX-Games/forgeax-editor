import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach, describe, expect, it } from 'bun:test';
import { createTestApplicationHost } from '../../../../../scripts/test-support/application-host';
import { registerViewportScopedKeybindings } from '../ViewportPanel';

try { GlobalRegistrator.register(); } catch { /* shared DOM test environment */ }

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  document.body.replaceChildren();
});

describe('Viewport contextual keybindings', () => {
  it('routes Delete through editor.delete when the viewport scope is active', async () => {
    const { host } = createTestApplicationHost();
    let deleteCalls = 0;
    host.commands.register({
      id: 'editor.delete',
      title: 'Delete selected entities',
      execute: () => {
        deleteCalls += 1;
        return { status: 'completed' as const };
      },
    });
    host.commands.register({
      id: 'editor.selectAll',
      title: 'Select all entities',
      execute: () => ({ status: 'completed' as const }),
    });
    cleanups.push(...registerViewportScopedKeybindings(host));

    const viewport = document.createElement('div');
    document.body.append(viewport);
    cleanups.push(host.keybindings.registerScope(viewport, 'editor.viewport'));

    const event = new KeyboardEvent('keydown', {
      key: 'Delete',
      bubbles: true,
      cancelable: true,
    });
    viewport.addEventListener('keydown', (current) => host.keybindings.handle(current as KeyboardEvent), { once: true });
    viewport.dispatchEvent(event);
    await Promise.resolve();

    expect(deleteCalls).toBe(1);
    expect(event.defaultPrevented).toBe(true);
  });
});
