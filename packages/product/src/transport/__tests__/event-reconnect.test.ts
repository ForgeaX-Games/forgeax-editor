import { expect, test } from 'bun:test';

import {
  createEventCursor,
  eventsAfterCursor,
  isTerminalTransportNotification,
} from '../service';

const events = [
  { sequence: 1, type: 'accepted' },
  { sequence: 2, type: 'running' },
  { sequence: 3, type: 'succeeded' },
] as const;

test('event cursor resumes after disconnect without replaying the acknowledged event', () => {
  const cursor = createEventCursor({ runId: 'run-1', snapshotRevision: 'rev-3', sequence: 1 });
  const resumed = eventsAfterCursor(events, cursor);
  expect(resumed).toEqual([events[1], events[2]]);
});

test('notifications are hints and terminal status comes from run state', () => {
  expect(isTerminalTransportNotification({ type: 'run.succeeded', runId: 'run-1' })).toBe(false);
  expect(isTerminalTransportNotification({ type: 'run.event', runId: 'run-1', event: { type: 'succeeded' } })).toBe(false);
  expect(isTerminalTransportNotification({ type: 'run.snapshot', runId: 'run-1', status: 'succeeded' })).toBe(false);
});
