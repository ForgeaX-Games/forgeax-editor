import { describe, expect, it } from 'bun:test';
import {
  ManifestV2Schema,
  normalizeManifest,
  parseAnyManifest,
  type WorkbenchManifest,
} from '../src/manifest';

describe('manifest v2', () => {
  it('accepts kind-agnostic page, panel, activity, and resource editor contributions', () => {
    const parsed = ManifestV2Schema.parse({
      schemaVersion: 2,
      id: '@forgeax/example',
      version: '1.0.0',
      displayName: 'Example',
      categories: ['workbench'],
      contributes: {
        panelTypes: [{ id: 'preview', runtime: 'iframe', entry: './preview.html' }],
        pages: [{
          id: 'main',
          title: 'Main',
          cardinality: 'singleton',
          layout: {
            version: 1,
            root: { kind: 'tabs', placements: ['preview'], active: 'preview' },
          },
          layoutVersion: 1,
          panels: [{ id: 'preview', panelType: { extension: 'self', id: 'preview' } }],
        }],
        activities: [{ id: 'launcher', title: 'Example', pageType: { extension: 'self', id: 'main' } }],
        resourceEditors: [{
          id: 'mesh',
          selector: { kinds: ['mesh'] },
          pageType: { extension: 'self', id: 'main' },
        }],
      },
    });
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.contributes.pages).toHaveLength(1);
  });

  it('normalizes a single-surface v1 workbench into one panel-backed singleton page and launcher', () => {
    const legacy: WorkbenchManifest = {
      schemaVersion: 1,
      id: '@forgeax/wb-example',
      version: '1.0.0',
      kind: 'workbench',
      displayName: 'Example',
      entry: { frontend: './src/index.tsx' },
      provides: { workbench: { id: 'example', position: 9, category: '2D' } },
    };
    const normalized = normalizeManifest(legacy);
    expect(normalized.categories).toEqual(['workbench']);
    expect(normalized.contributes.pages?.[0]).toMatchObject({
      id: 'example',
      cardinality: 'singleton',
      layoutVersion: 2,
      panels: [{ id: 'content' }],
      layout: {
        version: 2,
        root: { kind: 'tabs', placements: ['content'], active: 'content' },
      },
    });
    expect(normalized.contributes.panelTypes?.[0]).toMatchObject({ id: 'example.content', runtime: 'inline' });
    expect(normalized.contributes.activities?.[0]).toMatchObject({
      id: 'example.launcher',
      order: 9,
      category: '2D',
    });
    expect(parseAnyManifest(normalized).ok).toBe(true);
  });

  it('normalizes a split v1 workbench into logical sidebar and workspace placements', () => {
    const legacy: WorkbenchManifest = {
      schemaVersion: 1,
      id: '@forgeax/wb-split-example',
      version: '1.0.0',
      kind: 'workbench',
      displayName: 'Split Example',
      entry: { standalone: { start: 'bun run dev' } },
      provides: {
        workbench: {
          id: 'split-example',
          surface: 'split',
          panes: {
            left: { defaultWidth: 360, minWidth: 280, collapsible: false },
            center: { minWidth: 480 },
          },
        },
      },
    };
    const normalized = normalizeManifest(legacy);
    expect(normalized.contributes.panelTypes).toEqual([
      expect.objectContaining({ id: 'split-example.content', runtime: 'iframe' }),
    ]);
    expect(normalized.contributes.pages?.[0]).toMatchObject({
      layoutVersion: 2,
      panels: [
        {
          id: 'sidebar',
          panelType: { extension: 'self', id: 'split-example.content' },
          initialProps: { pane: 'left', defaultWidth: 360, minWidth: 280, collapsible: false },
        },
        {
          id: 'workspace',
          panelType: { extension: 'self', id: 'split-example.content' },
          initialProps: { pane: 'center', minWidth: 480 },
        },
      ],
      layout: {
        version: 2,
        root: {
          kind: 'split',
          direction: 'horizontal',
          sizes: [360, 480],
          children: [
            { kind: 'tabs', placements: ['sidebar'], active: 'sidebar' },
            { kind: 'tabs', placements: ['workspace'], active: 'workspace' },
          ],
        },
      },
    });
    expect(parseAnyManifest(normalized).ok).toBe(true);
  });
});
