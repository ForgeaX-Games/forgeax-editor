import type { AppHost, ContentBrowserRevealTarget } from '@forgeax/interface/core/app-shell/types';

/** Locate an asset or file in the mounted Content Browser via the neutral app bus. */
export async function revealInContentBrowser(host: AppHost, target: ContentBrowserRevealTarget): Promise<void> {
  if (!target.guid && !target.path) return;
  try {
    await host.commands.execute('app.panel.reveal', { id: 'ep:assets' });
  } catch {
    // Panel may already be visible; locating still proceeds over the bus.
  }
  requestAnimationFrame(() => requestAnimationFrame(() => host.bus.emit('content-browser:reveal', { target })));
}
