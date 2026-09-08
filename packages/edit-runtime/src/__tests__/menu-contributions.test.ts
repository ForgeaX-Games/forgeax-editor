import { describe, expect, it } from 'bun:test';
import { createEditorMenuExtension } from '../menu-contributions';

describe('createEditorMenuExtension — IDE assembly hook', () => {
  it('exports a host-registerable AppExtension', () => {
    const extension = createEditorMenuExtension();
    expect(extension.id).toBe('editor.menu-contributions');
    expect(extension.version).toBe('1.0.0');
    expect(typeof extension.setup()).toBe('function');
  });
});
