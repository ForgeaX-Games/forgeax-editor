/**
 * Boot driver — the React-side half of the boot splash handshake.
 *
 * The inline bootstrap in index.html exposes `window.__forgeaxBoot` with two
 * methods: `progress({pct, label})` and `done()`. While React is mounting we
 * call these to drive the visible progress bar; after the first paint we
 * fire `done()` so the splash fades out and the studio takes over.
 *
 * The contract is one-way and lossy: missing window.__forgeaxBoot (e.g. user
 * loaded a stripped index.html) is silently ignored — the studio still works,
 * just without splash control.
 */

interface BrandBootApi {
  progress(p: { pct: number; label?: string }): void;
  done(): void;
}

function bootApi(): BrandBootApi | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { __forgeaxBoot?: BrandBootApi }).__forgeaxBoot ?? null;
}

/**
 * Called at the top of main.tsx (before createRoot.render) to mark "JS is
 * executing, React is about to mount".
 */
export function bootStageEntry(): void {
  bootApi()?.progress({ pct: 60, label: 'mounting shell' });
}

/**
 * Called from <App/>'s first useEffect to mark "React tree is wired and
 * client-side effects are firing". One rAF later we declare done().
 */
export function bootStageAppMounted(): void {
  const api = bootApi();
  if (!api) return;
  api.progress({ pct: 92, label: 'wiring panels' });
  // Wait for the first composited paint so the splash fade lines up with
  // the real studio appearing underneath — otherwise the player sees a
  // brief blank flash.
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    api.done();
    return;
  }
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      api.progress({ pct: 100, label: 'ready' });
      api.done();
    });
  });
}
