// packages/interface/src/core/app-shell/logger.ts
import type { AppLogger } from './types';

export const consoleLogger: AppLogger = {
  debug: (m, ...r) => console.debug(`[app-shell] ${m}`, ...r),
  info:  (m, ...r) => console.info(`[app-shell] ${m}`, ...r),
  warn:  (m, ...r) => console.warn(`[app-shell] ${m}`, ...r),
  error: (m, ...r) => console.error(`[app-shell] ${m}`, ...r),
};
