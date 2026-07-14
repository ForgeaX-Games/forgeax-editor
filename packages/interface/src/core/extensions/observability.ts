// packages/interface/src/core/extensions/observability.ts
//
// Third PR-3 capability plugin. Exposes host.observability as thin getter +
// method wrappers over useShellStore's observability slice (consoleLog /
// networkLog / telemetry). Store still owns state until T24; the plugin is
// the SSOT public API.
//
// Deviation from plan §3 interface shape: the plan listed telemetry / traces /
// perception / permissions (4 slices). The store actually exposes consoleLog /
// networkLog / telemetry (3 slices) — see store-parts/observability.ts. Using
// the real shape rather than the plan's speculative one.
import type { AppExtension } from '../app-shell/types';
import { useShellStore } from '../../store';
import type { ConsoleEntry, NetworkEntry, TelemetryRecord } from '../../store';

export interface ObservabilityApi {
  readonly consoleLog: readonly ConsoleEntry[];
  pushConsole(entry: ConsoleEntry): void;
  clearConsole(): void;
  readonly networkLog: readonly NetworkEntry[];
  pushNetwork(entry: NetworkEntry): void;
  clearNetwork(): void;
  readonly telemetry: readonly TelemetryRecord[];
  pushTelemetry(records: TelemetryRecord[]): void;
  clearTelemetry(): void;
}

export const observabilityExtension: AppExtension = {
  id: 'observability', version: '1.0.0', provides: ['observability'],
  setup(ctx) {
    const cap: ObservabilityApi = {
      get consoleLog() { return useShellStore.getState().consoleLog; },
      pushConsole: (e) => useShellStore.getState().pushConsole(e),
      clearConsole: () => useShellStore.getState().clearConsole(),
      get networkLog() { return useShellStore.getState().networkLog; },
      pushNetwork: (e) => useShellStore.getState().pushNetwork(e),
      clearNetwork: () => useShellStore.getState().clearNetwork(),
      get telemetry() { return useShellStore.getState().telemetry; },
      pushTelemetry: (rs) => useShellStore.getState().pushTelemetry(rs),
      clearTelemetry: () => useShellStore.getState().clearTelemetry(),
    };
    ctx.host.extend('observability', cap);
  },
};
