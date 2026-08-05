# `@forgeax/editor-game-plugins`

Edit-host adapter for asset-resident game plugins.

This package owns only editor-specific discovery: it scans the selected game's
`assets/` tree through `/api/files/tree` and resolves stable import URLs. The
engine's `@forgeax/engine-app` package owns the runtime policy: importing each
module, measuring ECS registry deltas, returning the shared load/error contract,
and attaching registered systems to a fresh Play `World`.

The package does not depend on `@forgeax/editor-core`, so it does not cross the
Play host's VAG protocol boundary. Standalone Play owns a Vite-generated module
manifest in its separate browser realm; both discovery paths call the same
`@forgeax/engine-app` loader and therefore share the engine-owned component and
system registration policy without sharing a host adapter.
