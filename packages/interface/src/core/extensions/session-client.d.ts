// packages/interface/src/core/extensions/session-client.d.ts
//
// Pure module augmentation — refines `AppHost.session` from `unknown` to a
// typed `SessionCapability`. The interface itself lives in
// `./session-client.ts` for cleaner symbol resolution; this file exists only
// so callers can `import './core/extensions/session-client.d'` for the type
// side-effect without pulling in the plugin's runtime code.

import type { SessionCapability } from './session-client';

declare module '../app-shell/types' {
  interface AppHost {
    readonly session?: SessionCapability;
  }
}

export {}; // ensure this file is treated as a module, not a global script
