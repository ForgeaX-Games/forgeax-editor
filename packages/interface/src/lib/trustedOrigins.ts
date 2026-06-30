// Origin gate for cross-iframe `message` receivers in the shell.
//
// The interface embeds child iframes (engine Play :15173 / Edit :15280, plugin
// panels) and receives postMessage from them. Receivers historically did NO
// origin check, so any foreign page/iframe sharing the message bus could inject
// VAG_* / health / context-menu / navigate events. This helper is the shell's
// trust boundary.
//
// Kept interface-LOCAL on purpose: `packages/interface` keeps ZERO `@forgeax/editor*`
// imports (an architectural invariant — see App.tsx / healthBridge.ts / panelRenderers),
// so we cannot reuse the editor protocol's `allowedParentOrigins`. The rule:
//   - PROD: studio is single-origin (:18920 proxies /preview + /editor) → strict
//     same-origin. A non-same-origin message in prod is foreign → reject.
//   - DEV (split-port): engine/editor run on localhost ports → allow localhost /
//     127.0.0.1 origins so split-dev keeps working.

/** True if `origin` is the shell's own origin, or (dev only) a localhost port.
 *  Also accepts private-network origins (10.x / 172.16-31.x / 192.168.x) so
 *  WSL2 forwarded addresses work without opening the gate to the public web. */
export function isTrustedMessageOrigin(origin: string): boolean {
  try {
    if (origin === window.location.origin) return true;
  } catch { /* no window.location */ }
  if (import.meta.env.DEV) {
    try {
      const host = new URL(origin).hostname;
      if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return true;
      if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(host)) return true;
    } catch { /* opaque/empty origin */ }
  }
  return false;
}
