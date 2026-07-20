// packages/interface/src/core/extensions/workbench-client.d.ts
import type { WorkbenchCapability } from './workbench-client';

declare module '../app-shell/types' {
  interface AppHost {
    readonly workbench?: WorkbenchCapability;
  }
}
export {};
