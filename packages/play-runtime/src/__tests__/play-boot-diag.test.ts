import { describe, expect, test } from 'bun:test';
import { playBootDiagMark } from '../play-boot-diag';

describe('play-boot-diag', () => {
  test('playBootDiagMark is safe to call', () => {
    expect(() => playBootDiagMark('test.phase', { ok: true })).not.toThrow();
  });
});
