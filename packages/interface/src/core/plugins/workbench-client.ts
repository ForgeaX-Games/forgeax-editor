// packages/interface/src/core/plugins/workbench-client.ts
import type { AppPlugin } from '../app-shell/types';
import type { WorkbenchClient } from '../../store-parts/workbench-client';
import { getWorkbenchClient, hasWorkbenchClient } from '../../store-parts/workbench-client';

export interface WorkbenchCapability {
  readonly client: WorkbenchClient;
}

export const workbenchClientPlugin: AppPlugin = {
  id: 'workbench-client', version: '1.0.0', provides: ['workbench'],
  setup(ctx) {
    // Graceful degradation: no composition-root injection (interface-alone /
    // standalone editor) → skip host.workbench instead of throwing at boot.
    if (!hasWorkbenchClient()) {
      ctx.log.info('[workbench-client] no client configured — host.workbench skipped (studio-only capability)');
      return;
    }
    const cap: WorkbenchCapability = { client: getWorkbenchClient() };
    ctx.host.extend('workbench', cap);
  },
};
