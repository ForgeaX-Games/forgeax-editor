import process from 'node:process';

// CI_BUN_PATH is written by the shared CI environment action after it has
// verified the run-scoped installation. Local callers are launched by Bun, so
// process.execPath is the same exact runtime in that case.
export const BUN_EXECUTABLE = process.env.CI_BUN_PATH || process.execPath;

export function resolveBunExecutable(command, env = process.env) {
  return command === 'bun' ? (env.CI_BUN_PATH || process.execPath) : command;
}
