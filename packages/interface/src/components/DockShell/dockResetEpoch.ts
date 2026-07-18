// Monotonic epoch for `app.dock.reset`.
//
// Callers (layout menu, onboarding tour) may fire reset before a DockRegion has
// subscribed to `dock:reset` or before dockview `onReady` has set `api`. Bumping
// this epoch at request time lets each region apply the reset exactly once when
// it becomes ready — no timers, no localStorage poking.

let epoch = 0;

export function bumpDockResetEpoch(): void {
  epoch += 1;
}

export function getDockResetEpoch(): number {
  return epoch;
}
