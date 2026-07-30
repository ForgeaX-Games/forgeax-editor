import {
  createRuntimeAvailability,
  unavailableRuntimeError,
  type GameRuntimePort,
} from '../contracts/runtime';

export interface HeadlessRuntimeOptions {
  readonly port: GameRuntimePort;
}

export function createHeadlessRuntime(options: HeadlessRuntimeOptions): GameRuntimePort {
  return options.port;
}

export function headlessAvailability(): ReturnType<typeof createRuntimeAvailability> {
  return createRuntimeAvailability({
    host: 'bun',
    capabilities: {
      play: { available: true },
      stop: { available: true },
      query: { available: true },
      fixedStep: { available: true },
      dispose: { available: true },
      capture: { available: false, code: 'display-unavailable', reason: 'headless runtime has no display surface' },
      reveal: { available: false, code: 'display-unavailable', reason: 'headless runtime has no focusable display surface' },
    },
  });
}

export { unavailableRuntimeError };
