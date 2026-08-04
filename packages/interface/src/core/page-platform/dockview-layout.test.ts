import { describe, expect, it } from 'bun:test';
import type { PageLayoutEnvelope, QualifiedPanelTypeId } from '@forgeax/types';
import { pageLayoutToDockview } from './dockview-layout';

const panelTypeId = '@forgeax-extension/example#panel/content' as QualifiedPanelTypeId;

describe('pageLayoutToDockview', () => {
  it('uses Page layout state for horizontal panel positions', () => {
    const layout: PageLayoutEnvelope = {
      version: 2,
      root: {
        kind: 'split',
        direction: 'horizontal',
        sizes: [420, 780],
        children: [
          { kind: 'tabs', placements: ['sidebar'], active: 'sidebar' },
          { kind: 'tabs', placements: ['workspace'], active: 'workspace' },
        ],
      },
    };
    const serialized = pageLayoutToDockview('video', 'Video Game', [
      { id: 'sidebar', panelTypeId },
      { id: 'workspace', panelTypeId },
    ], layout);

    expect(serialized.grid.root).toMatchObject({
      type: 'branch',
      data: [
        { type: 'leaf', size: 420, data: { views: ['sidebar'], activeView: 'sidebar' } },
        { type: 'leaf', size: 780, data: { views: ['workspace'], activeView: 'workspace' } },
      ],
    });
    expect(serialized.activeGroup).toBe('page-video-1');
  });

  it('uses the Page title for a single placement', () => {
    const serialized = pageLayoutToDockview('main', 'Scene Generator', [
      { id: 'content', panelTypeId },
    ], {
      version: 1,
      root: { kind: 'tabs', placements: ['content'], active: 'content' },
    });

    expect(serialized.panels.content?.title).toBe('Scene Generator');
  });
});
