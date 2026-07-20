// packages/interface/src/test-utils/mockHost.ts
//
// Test-only helper that builds an AppHost with fake capabilities injected via
// host.extend. Tests that used to mock the useShellStore slice for
// session/workbench/observability data can instead:
//
//   render(<HostProvider value={mockHost({ session: { tabs: [], activeSid: null } })}>
//     <Component />
//   </HostProvider>);
//
// The remaining useShellStore state (UI shell) can still be mocked the old way
// or seeded via setState on the real store.
import type { AppHost } from '../core/app-shell';
import { createAppHost } from '../core/app-shell';

export interface MockHostOverrides {
  session?: Record<string, unknown>;
  workbench?: Record<string, unknown>;
  observability?: Record<string, unknown>;
  [extension: string]: unknown;
}

export function mockHost(overrides: MockHostOverrides = {}): AppHost {
  const { host, control } = createAppHost();
  for (const [cap, api] of Object.entries(overrides)) {
    if (api === undefined) continue;
    // Bypass the plugin-setup guard using a synthetic manifest so tests can
    // extend the host without going through the plugin loader.
    const manifest = { id: `test.${cap}`, version: '1.0.0', provides: [cap], setup: () => {} };
    control.beginSetup(manifest as any);
    host.extend(cap, api);
    control.endSetup();
  }
  return host;
}
