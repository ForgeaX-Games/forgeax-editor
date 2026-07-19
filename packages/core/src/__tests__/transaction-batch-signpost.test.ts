// P9 (solo round-18) — the `transaction` op is the O(N) BULK-AUTHORING path; a per-op
// `for (…) await gateway.dispatch(spawnEntity)` loop is O(N²) (each await yields a frame →
// a full-world repaint per op; measured 500 spawns = ~200s awaited-loop vs ~0.9s transaction).
// That performance/atomicity contract must be discoverable through the tool's OWN
// self-introspection surface (`listOps()`), the same progressive-disclosure convention
// spawn/duplicate/createMaterial already follow — NOT only in an external doc a docs-only AI
// might never read. This test freezes that signpost so it can't silently regress to a bare
// `title:'Transaction'` (which gave zero guidance and let the O(N²) trap look like the only path).
//
// Revert-to-red: strip the field descriptions from catalog.ts's transaction descriptor → red.
import { describe, test, expect } from 'bun:test';
import { getOp } from '../io/catalog';

describe('P9 transaction batch signpost (solo round-18)', () => {
  test('listOps()[transaction] projects the O(N) bulk-authoring + atomicity contract', () => {
    const op = getOp('transaction');
    expect(op).toBeDefined();
    const props = op?.argsSchema?.properties as Record<string, { description?: string }> | undefined;
    expect(props).toBeDefined();

    // both required fields carry a semantic description (progressive disclosure, charter P1/F1)
    const label = props?.label?.description ?? '';
    const commands = props?.commands?.description ?? '';
    expect(label.length).toBeGreaterThan(0);
    expect(commands.length).toBeGreaterThan(0);

    // the commands description names the scale contract so a self-introspecting AI is steered
    // off the O(N²) await-loop and onto the O(N) batch path.
    expect(commands.toLowerCase()).toContain('o(n²)'); // "O(N²)" — the trap it warns against
    expect(commands.toLowerCase()).toMatch(/bulk|batch/);
    expect(commands.toLowerCase()).toContain('await'); // names the await-loop reflex as the trap

    // the label description names atomicity/single-undo (the other half of transaction's contract)
    expect(label.toLowerCase()).toMatch(/atomic|one undo|single|undo/);
  });
});
