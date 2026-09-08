import manifest from './fixtures/editor-baseline.json';

export interface EditorBaselineAdapter {
  readonly manifest: typeof manifest;
  activate(): { contribution: string; requiredCapability: string };
}

export function createEditorBaselineAdapter(): EditorBaselineAdapter {
  return {
    manifest,
    activate: () => ({ contribution: 'editor.edit', requiredCapability: 'engine.preview.create' }),
  };
}
