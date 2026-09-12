import { describe, expect, it } from 'bun:test';
import { runtimeFailure } from '../runtime-failure';

describe('runtime failure transport', () => {
  it('preserves the missing-camera cause wrapped as a device operation failure', () => {
    const cause = Object.assign(new Error('A camera is required'), {
      code: 'render-system-no-camera', hint: 'Add a Camera and Transform to the game world.',
    });
    const error = Object.assign(new Error('Device operation failed'), {
      code: 'device-operation-failed', detail: { cause },
    });
    const failure = runtimeFailure(error, 'now');
    expect(failure.code).toBe('render-system-no-camera');
    expect(failure.hint).toBe(cause.hint);
    expect(failure.message).toContain('Device operation failed');
    expect(failure.message).toContain('render-system-no-camera');
    expect(failure.retryable).toBe(false);
  });

  it('still identifies genuine device loss and tolerates cyclic/unknown errors', () => {
    const lost = { code: 'device-lost', hint: 'The device was lost.' };
    expect(runtimeFailure({ code: 'device-operation-failed', detail: { cause: lost } }).stage).toBe('device-lost');
    const cyclic: Record<string, unknown> = { code: 'device-operation-failed' };
    cyclic.detail = { cause: cyclic };
    expect(runtimeFailure(cyclic).code).toBe('device-operation-failed');
    expect(runtimeFailure(null).code).toBe('renderer-error');
  });
});
