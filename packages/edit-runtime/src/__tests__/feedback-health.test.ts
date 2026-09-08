import { describe, expect, it } from 'bun:test';
import {
  errorMessage,
  isReportablePlayFailure,
  normalizeCarrierFailureCode,
  normalizePlayFailureCode,
  normalizeRendererFailureCode,
  normalizeSaveFailureCode,
} from '../feedback-health';

describe('passive feedback health normalization', () => {
  it('maps concrete save owners to the documented save failure families', () => {
    expect(normalizeSaveFailureCode({ code: 'scene-serialization-error' })).toBe('save-serialization-failed');
    expect(normalizeSaveFailureCode({ code: 'pack-validation-error' })).toBe('save-pack-validation-failed');
    expect(normalizeSaveFailureCode({ code: 'platform-write-denied' })).toBe('save-write-failed');
  });

  it('maps Play lifecycle errors without parsing their human hint', () => {
    expect(normalizePlayFailureCode({ code: 'play-save-rejected' })).toBe('play-save-failed');
    expect(normalizePlayFailureCode({ code: 'play-carrier-boot-failed' })).toBe('play-bootstrap-failed');
    expect(normalizePlayFailureCode({ code: 'scene-assets-not-ready' })).toBe('play-assemble-failed');
  });

  it('classifies a dead render loop as renderer, not as a failed Play launch', () => {
    // Regression: a real ECS update throw arrives on the Play lifecycle callback
    // as `app-system-update-failed`. Requirements §4 classifies by blocked work
    // surface — Play started, then rendering died → 渲染进程异常终止.
    expect(normalizePlayFailureCode({ code: 'app-system-update-failed' })).toBe('renderer-error');
    expect(normalizePlayFailureCode({ code: 'renderer-process-terminated' })).toBe('renderer-process-terminated');
    // Genuine launch failures must stay in the Play family.
    expect(normalizePlayFailureCode({ code: 'play-carrier-ready-timeout' })).toBe('play-bootstrap-failed');
  });

  it('does not turn documented expected Play refusals into passive incidents', () => {
    expect(isReportablePlayFailure({ code: 'render-system-no-camera' })).toBe(false);
    expect(isReportablePlayFailure({ code: 'play-cancelled-dirty' })).toBe(false);
    expect(isReportablePlayFailure({ code: 'play-carrier-boot-failed' })).toBe(true);
  });

  it('keeps GPU loss distinct from other renderer failures', () => {
    expect(normalizeRendererFailureCode({ code: 'device-lost' })).toBe('device-lost');
    expect(normalizeRendererFailureCode({ code: 'webgpu-runtime-error' })).toBe('webgpu-init-failed');
    expect(normalizeRendererFailureCode({ code: 'app-system-update-failed' })).toBe('renderer-error');
  });

  it('preserves a real stack for automatic feedback evidence', () => {
    const error = new Error('disk rejected');
    expect(errorMessage(error, 'fallback')).toContain('disk rejected');
    expect(errorMessage({ hint: 'structured hint' }, 'fallback')).toBe('structured hint');
  });
});

/** Regression gate for the escape class that shipped silently once already:
 *  `host-session.ts` forwarded the carrier's raw `failure.code`, and 13 of the
 *  19 codes the carrier can actually emit matched no classifier preset — so a
 *  real Play failure produced no card at all. Every code the carrier union can
 *  produce must land in a documented family.
 */
describe('carrier failure codes never escape the classifier', () => {
  // Mirrors the `code:` literals reachable through disposable-play-carrier's
  // two onFailure paths. Extend this list whenever the carrier gains a code.
  const CARRIER_CODES = [
    'play-carrier-not-active',
    'play-carrier-window-unavailable',
    'play-gameplay-request-invalid',
    'play-gameplay-request-timeout',
    'play-gameplay-request-post-failed',
    'play-carrier-stopped',
    'play-carrier-transition-active',
    'play-carrier-ready-timeout',
    'play-carrier-capture-unavailable',
    'play-carrier-capture-stale',
    'play-carrier-capture-invalid',
    'play-carrier-provenance-unavailable',
    'renderer-process-terminated',
    'viewport-runtime-disconnected',
    'rhi-debug-unavailable',
    'edit-surface-restore-failed',
    'device-lost',
    'context-lost',
    'renderer-error',
  ] as const;

  // The nine documented incident families the classifier recognizes.
  const KNOWN = new Set([
    'save-serialization-failed', 'save-write-failed', 'save-pack-validation-failed',
    'play-assemble-failed', 'play-save-failed', 'play-bootstrap-failed',
    'device-lost', 'context-lost', 'webgpu-init-failed',
    'renderer-process-terminated', 'renderer-crash', 'renderer-error',
    'renderer-not-ready', 'renderer-provenance-unavailable', 'app-system-update-failed',
    'runtime-unavailable', 'runtime-disconnected', 'viewport-runtime-disconnected',
  ]);

  for (const code of CARRIER_CODES) {
    it(`maps ${code} into a documented family`, () => {
      expect(KNOWN.has(normalizeCarrierFailureCode({ code, stage: 'runtime', hint: code }))).toBe(true);
    });
  }

  it('routes heartbeat-stage failures to runtime disconnect', () => {
    expect(normalizeCarrierFailureCode({ code: 'whatever-unknown', stage: 'heartbeat', hint: '' }))
      .toBe('viewport-runtime-disconnected');
  });

  it('is total — an unknown future code still yields a reportable family', () => {
    expect(normalizeCarrierFailureCode({ code: 'brand-new-carrier-fault', stage: 'runtime', hint: '' }))
      .toBe('renderer-error');
    expect(normalizeCarrierFailureCode(null)).toBe('renderer-error');
  });
});
