// packages/interface/src/core/extensions/observability.d.ts
import type { ObservabilityApi } from './observability';

declare module '../app-shell/types' {
  interface AppHost {
    readonly observability?: ObservabilityApi;
  }
}
export {};
