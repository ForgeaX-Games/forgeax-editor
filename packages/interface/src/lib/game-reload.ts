// Engine settle helper for game activation.
//
// Switching games changes the private runtime mount used by the preview
// engine. The UI waits for the engine to be healthy before rebinding sessions;
// no page-wide workspace reload is involved.
export async function waitForEngineSettled(slug?: string): Promise<void> {
  if (typeof window === 'undefined' || !slug) return;
  const url = `/preview/?game=${encodeURIComponent(slug)}`;
  const deadline = Date.now() + 8000;
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const ping = async (): Promise<boolean> => {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      try { await r.body?.cancel(); } catch { /* ignore */ }
      return r.ok;
    } catch { return false; }
  };
  await wait(600);
  let streak = 0;
  while (Date.now() < deadline) {
    streak = (await ping()) ? streak + 1 : 0;
    if (streak >= 2) return;
    await wait(250);
  }
}
