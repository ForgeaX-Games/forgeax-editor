// @forgeax/engine-rhi-debug/src/__tests__/cli.test.ts
//
// CLI --help snapshot tests: capture-frame --help and inspect-at --help.
// Verifies flag table presence (each flag has name + type + description)
// and example invocation presence.
//
// TDD red-green-refactor (plan-strategy 5.1): M-7 test layer for AC-22.
// Snapshot is inline so vitest diff catches flag changes automatically
// (charter P2: explicit failure -- flag change breaks snapshot).
//
// Related: m7-4; requirements AC-22.

import { describe, expect, it } from 'vitest';
import { getCaptureFrameHelp, getInspectAtHelp } from '../cli';

describe('CLI --help output', () => {
  describe('capture-frame --help', () => {
    it('m7-4 snapshot: capture-frame --help matches snapshot (flag table + example)', () => {
      const help = getCaptureFrameHelp();
      expect(help).toMatchInlineSnapshot(`
        "Usage: capture-frame [--frames=N] [--label=STR] [--target=WS]

        Capture N frames from a running forgeax engine via WebSocket JSON-RPC.

        Flags:
          --frames=N     Number of frames to capture (default: 1).
          --label=STR    Optional label for the capture run.
          --target=WS    WebSocket target URL (default: ws://localhost:5732).

        Example:
          forgeax-engine-console capture-frame --frames=1 --label=test

        Output:
          JSON object with tapePaths array containing runId, tapePath, and reportPath."
      `);
    });

    it('m7-4 flag table: capture-frame --help contains frames flag', () => {
      const help = getCaptureFrameHelp();
      expect(help).toContain('--frames');
      expect(help).toContain('Number of frames');
      expect(help).toContain('default: 1');
    });

    it('m7-4 flag table: capture-frame --help contains label flag', () => {
      const help = getCaptureFrameHelp();
      expect(help).toContain('--label');
      expect(help).toContain('label');
    });

    it('m7-4 flag table: capture-frame --help contains target flag', () => {
      const help = getCaptureFrameHelp();
      expect(help).toContain('--target');
      expect(help).toContain('ws://localhost:5732');
    });

    it('m7-4 example: capture-frame --help contains example invocation', () => {
      const help = getCaptureFrameHelp();
      expect(help).toContain('forgeax-engine-console capture-frame');
      expect(help).toContain('Example:');
    });
  });

  describe('inspect-at --help', () => {
    it('m7-4 snapshot: inspect-at --help matches snapshot (flag table + example)', () => {
      const help = getInspectAtHelp();
      expect(help).toMatchInlineSnapshot(`
        "Usage: inspect-at <tapePath> <drawIdx> [--fields=LIST] [--target=WS]

        Inspect a specific draw index within a captured tape.

        Arguments:
          tapePath     Path to the .tape.bin file to inspect.
          drawIdx      Global draw event index to inspect (integer >= 0).

        Flags:
          --fields=LIST   Comma-separated fields to include: bindings,drawCall,rt (default: all).
          --target=WS     WebSocket target URL (default: ws://localhost:5732).

        Example:
          forgeax-engine-console inspect-at .forgeax-debug/2026-06-12T120000Z-abcd/frame-0.tape.bin 42 --fields=bindings,rt

        Output:
          JSON InspectReport with frameIdx, drawIdx, passIdx, and requested fields."
      `);
    });

    it('m7-4 flag table: inspect-at --help contains fields flag', () => {
      const help = getInspectAtHelp();
      expect(help).toContain('--fields');
      expect(help).toContain('bindings,drawCall,rt');
    });

    it('m7-4 flag table: inspect-at --help contains target flag', () => {
      const help = getInspectAtHelp();
      expect(help).toContain('--target');
      expect(help).toContain('ws://localhost:5732');
    });

    it('m7-4 arguments: inspect-at --help contains positional argument docs', () => {
      const help = getInspectAtHelp();
      expect(help).toContain('tapePath');
      expect(help).toContain('drawIdx');
    });

    it('m7-4 example: inspect-at --help contains example invocation', () => {
      const help = getInspectAtHelp();
      expect(help).toContain('forgeax-engine-console inspect-at');
      expect(help).toContain('Example:');
      expect(help).toContain('--fields=bindings,rt');
    });
  });
});
