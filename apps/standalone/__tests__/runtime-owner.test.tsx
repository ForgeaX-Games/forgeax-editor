import { expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { createApplicationRuntimeOwner } from '@forgeax/app-shell/application';
import { StandaloneRuntimeRoot } from '../StandaloneRuntimeRoot';

const messages = { title: 'Render failed', hint: 'Recover', retry: 'Retry', remount: 'Remount', reloadApplication: 'Reload' };
const shutdownMessages = { title: 'Cleanup pending', hint: 'Finish closing first', retry: 'Retry cleanup' };

for (const retryable of [true, false]) test(`replacement retains failed cleanup (retryable=${retryable})`, async () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const element = document.createElement('div');
  const root = createRoot(element);
  const deferred = new Error('close pending');
  const owner = createApplicationRuntimeOwner({ isCleanupDeferred: error => retryable && error === deferred });
  let starts = 0;
  let closes = 0;
  let blocked = true;
  let reloads = 0;
  const start = async () => ({ host: {} as never, id: ++starts, dispose() {
    closes++;
    if (blocked) throw deferred;
  } });
  const render = (factory: typeof start) => root.render(createElement(StandaloneRuntimeRoot, {
    createOwner: () => owner, start: factory, messages, shutdownMessages,
    revealError: () => {}, reloadApplication: () => { reloads++; },
    children: () => createElement('span', null, 'Running'),
  }));
  try {
    await act(async () => { render(start); });
    await act(async () => { render(() => start()); });
    expect(starts).toBe(1);
    expect(closes).toBe(1);
    expect(element.textContent).toContain('Cleanup pending');
    const retry = element.querySelector<HTMLButtonElement>('[data-testid="retry-shutdown"]');
    expect(Boolean(retry)).toBe(retryable);
    if (retry) {
      blocked = false;
      await act(async () => { retry.click(); });
      expect(starts).toBe(2);
      expect(closes).toBe(2);
      expect(element.textContent).toBe('Running');
    } else {
      await act(async () => { element.querySelector('button')!.click(); });
      expect(reloads).toBe(1);
      expect(closes).toBe(1);
    }
  } finally {
    blocked = false;
    await act(async () => { root.unmount(); });
    await GlobalRegistrator.unregister();
  }
});
