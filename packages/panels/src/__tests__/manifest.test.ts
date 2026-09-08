import { describe, expect, it } from 'bun:test';
import React from 'react';
import { createEditorPanelsExtension } from '../manifest';

function SceneEditor(): React.ReactNode {
  return null;
}

describe('createEditorPanelsExtension', () => {
  it('owns editor panel metadata and windowing for every host', () => {
    const extension = createEditorPanelsExtension({ SceneEditor });
    const contribution = extension.contributes?.panels;
    const hierarchy = contribution?.panels?.hierarchy;
    const assets = contribution?.panels?.assets;

    expect(extension.id).toBe('panels.editor');
    expect(contribution?.surfaces?.SceneEditor).toBe(SceneEditor);
    expect(hierarchy?.header).toEqual({ visible: true, showTitle: false });
    expect(hierarchy?.content).toEqual({ padding: 'none', scroll: 'none', tone: 'tool' });
    expect(assets?.title).toBe('Content Browser');
    expect(assets?.content).toEqual({ padding: 'none', scroll: 'none', tone: 'tool' });
    expect(hierarchy?.windowing?.createTarget()).toEqual({
      surface: { kind: 'panel', id: 'ep:hierarchy' },
      title: 'Hierarchy',
      width: 960,
      height: 720,
      dockBehavior: 'close',
    });
  });
});
