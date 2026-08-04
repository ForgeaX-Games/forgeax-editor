import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';

const panel = readFileSync(resolve(import.meta.dir, '..', 'Inspector.tsx'), 'utf8');
const draft = readFileSync(resolve(import.meta.dir, '..', 'useNumberDraft.ts'), 'utf8');

describe('Inspector draft focus and live pulse contracts', () => {
  it('keeps focused and scrubbed values ahead of live selector updates', () => {
    expect(panel).toContain('const shown = drag ? drag.v : liveValue;');
    expect(panel).toContain('const num = useNumberDraft(shown, fs, onCommit, generation);');
    expect(panel).toContain('data-scrubbing={isScrubbing}');
    expect(draft).toContain('value: draft !== null ? draft : String(display),');
    expect(draft).toContain('const changed = useRef(false);');
    expect(draft).toContain('if (!changed.current)');
    expect(draft).toContain('onFocus: () => { changed.current = false; setDraft(String(display)); },');
  });

  it('keys draft identity by selection and world generation', () => {
    expect(panel).toContain('const selectionGeneration = `${sel ?? \'none\'}:${worldGeneration}:${gateway.mode}`;');
    expect(panel).toContain('key={`${selectionGeneration}:${r.key}`}');
    expect(panel).toContain('useEffect(() => {\n    cancelDraft();\n  }, [sel, worldGeneration]);');
    expect(draft).toContain('setDraft(null);');
    expect(draft).toContain('}, [generation]);');
  });

  it('restores rotation overlay from the live quaternion after cancellation', () => {
    expect(panel).toContain('setRotationDraft(quatToEuler(q[0]!, q[1]!, q[2]!, q[3]!));');
    expect(panel).toContain('const [qx, qy, qz, qw] = eulerToQuat');
    expect(panel).toContain('rotationDraft');
  });
});
