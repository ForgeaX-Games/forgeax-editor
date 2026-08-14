import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';

const panelsDir = resolve(import.meta.dir, '..');
const hierarchy = readFileSync(resolve(panelsDir, 'Hierarchy.tsx'), 'utf8');
const contributions = readFileSync(resolve(panelsDir, 'HierarchyContributions.tsx'), 'utf8');
const inspector = readFileSync(resolve(panelsDir, 'Inspector.tsx'), 'utf8');
const viewport = readFileSync(resolve(panelsDir, '..', '..', 'edit-runtime', 'src', 'viewport', 'ViewportComponent.tsx'), 'utf8');

describe('Hierarchy Editor World chrome', () => {
  it('registers a header toggle command and data-testid', () => {
    expect(contributions).toContain("id: 'hierarchy.editorWorld.toggle'");
    expect(contributions).toContain('data-testid="hier-editor-world-toggle"');
    expect(contributions).toContain('toggleHierarchyShowEditorWorld');
    // Lives in the settings menu so the smoke layout test still sees
    // hierarchy.settings.control — an extra header icon folds settings away.
    expect(contributions).not.toContain("id: 'hierarchy.editorWorld.control'");
  });

  it('projects editorWorld as a chrome folder, not a scene setSelection target', () => {
    expect(hierarchy).toContain('hier-row-editor-folder');
    expect(hierarchy).toContain('inspectEditorEntity');
    expect(hierarchy).toContain('setHierarchyEditorInspection');
    expect(hierarchy).toContain('getEditorWorldProjection');
    // The editor-row click path must never mint a scene HandlePair from the
    // editor camera handle (pack-play litmus / handle collision).
    const inspectFn = hierarchy.slice(
      hierarchy.indexOf('function inspectEditorEntity'),
      hierarchy.indexOf('function inspectEditorEntity') + 420,
    );
    expect(inspectFn).toContain('setHierarchyEditorInspection(id)');
    expect(inspectFn).toContain("kind: 'setSelection'");
    expect(inspectFn).toContain('id: null');
    expect(inspectFn).not.toContain('id: id');
  });

  it('Inspector shows a read-only chrome strip for the editor camera', () => {
    expect(inspector).toContain('inspector-editor-world-chrome');
    expect(inspector).toContain('EditorWorldChromeInspector');
    expect(inspector).toContain('getEditorWorldProjection');
  });

  it('spawns the orbit camera with a Name and registers the projection provider', () => {
    expect(viewport).toContain("value: 'Editor Camera'");
    expect(viewport).toContain('registerEditorWorldProjectionProvider');
  });
});
