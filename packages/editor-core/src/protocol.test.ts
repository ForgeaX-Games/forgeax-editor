// protocol.test.ts — TDD red-stage tests for sendVagMessage + VagMessageError.
//
// These tests are written BEFORE the implementation (w4). They MUST fail
// until the sendVagMessage helper and VagMessageError class are implemented
// in protocol.ts.
//
// Anchors:
//   plan-tasks.json w1: TDD red-green-refactor
//   requirements §5 AC-16: structured failure path assertion
//   plan-strategy §2 D-6: throw VagMessageError, no-op on null target

import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { z } from 'zod';
import { sendVagMessage, VagMessageError, VagConsoleSchema } from './protocol';

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Create a minimal postMessage mock on a fake window object. */
function mockWindow() {
  const postMessage = mock(() => {});
  const win = { postMessage } as unknown as Window & typeof globalThis;
  return { win, postMessage };
}

// ── sendVagMessage success path ─────────────────────────────────────────────────

describe('sendVagMessage (success path)', () => {
  it('should call postMessage with structured payload when schema and payload are valid', () => {
    const { win, postMessage } = mockWindow();
    const payload = { level: 'warn' as const, text: 'hello', ts: 1000 };
    sendVagMessage(win, VagConsoleSchema, payload);

    expect(postMessage).toHaveBeenCalledTimes(1);
    const [msg] = postMessage.mock.calls[0] as [Record<string, unknown>, string];
    expect(msg.type).toBe('VAG_CONSOLE');
    expect(msg.payload).toEqual(payload);
  });
});

// ── sendVagMessage failure path (VagMessageError) ───────────────────────────────

describe('sendVagMessage (failure path — VagMessageError)', () => {
  it('should throw VagMessageError when schema.safeParse fails', () => {
    const { win } = mockWindow();
    // Missing required field 'text'
    const badPayload = { level: 'info' as const, ts: 42 };

    let caught: VagMessageError | null = null;
    try {
      sendVagMessage(win, VagConsoleSchema, badPayload as never);
    } catch (e) {
      caught = e as VagMessageError;
    }

    // Throw occurred
    expect(caught).not.toBeNull();
    expect(caught).toBeInstanceOf(VagMessageError);

    // Structured properties accessible by attribute access (charter P3)
    expect(caught!.code).toBe('VAG_SCHEMA_MISMATCH');
    expect(Array.isArray(caught!.issues)).toBe(true);
    expect(caught!.issues.length).toBeGreaterThan(0);
    // At least one issue mentions the missing 'text' field
    const missingText = caught!.issues.some(
      (iss: z.ZodIssue) => iss.path.includes('text'),
    );
    expect(missingText).toBe(true);

    // hint and expected are strings (human-readable)
    expect(typeof caught!.hint).toBe('string');
    expect(caught!.hint.length).toBeGreaterThan(0);
    expect(typeof caught!.expected).toBe('string');
    expect(caught!.expected.length).toBeGreaterThan(0);
  });
});

// ── sendVagMessage null/undefined target (no-op) ────────────────────────────────

describe('sendVagMessage (null/undefined target — no-op)', () => {
  it('should not throw and not call anything when target is null', () => {
    const payload = { level: 'log' as const, text: 'ignored', ts: 0 };
    // Should not throw
    expect(() => sendVagMessage(null, VagConsoleSchema, payload)).not.toThrow();
  });

  it('should not throw and not call anything when target is undefined', () => {
    const payload = { level: 'log' as const, text: 'ignored', ts: 0 };
    expect(() =>
      sendVagMessage(undefined, VagConsoleSchema, payload),
    ).not.toThrow();
  });
});