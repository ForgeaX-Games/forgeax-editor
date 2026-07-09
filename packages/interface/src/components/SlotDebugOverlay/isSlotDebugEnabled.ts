// URL gate for the slot debug overlay. Returns true when the current URL's
// `debug` query flag contains the `slots` token (comma-separated so future
// flags can compose: `?debug=slots,other`). SSR / non-window contexts fall
// through to false so importing this module never crashes outside the browser.
export function isSlotDebugEnabled(
  search: string = typeof window !== 'undefined' ? window.location.search : '',
): boolean {
  try {
    const p = new URLSearchParams(search);
    const debug = p.get('debug');
    if (!debug) return false;
    return debug.split(',').some((f) => f.trim() === 'slots');
  } catch {
    return false;
  }
}
