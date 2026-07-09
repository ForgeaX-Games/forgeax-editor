// packages/interface/src/core/plugins/observability.d.ts
import type { ObservabilityApi } from './observability';

declare module '../app-shell/types' {
  interface AppHost {
    readonly observability?: ObservabilityApi;
  }
}
export {};
