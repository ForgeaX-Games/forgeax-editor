import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';

const source = readFileSync(resolve(import.meta.dir, '..', 'ViewportComponent.tsx'), 'utf8');

describe('editor camera Name + chrome projection', () => {
  it('stamps Name on the editorWorld orbit camera so Hierarchy can label it', () => {
    expect(source).toContain("component: Name");
    expect(source).toContain("value: 'Editor Camera'");
  });

  it('registers the editor-world projection provider after spawn', () => {
    expect(source).toContain('registerEditorWorldProjectionProvider');
    expect(source).toContain('getEditorCameraEntity');
    expect(source).toContain("typeId: 'Camera'");
  });
});
