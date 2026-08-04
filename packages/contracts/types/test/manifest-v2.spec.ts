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
          layout: './main.page.json',
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

  it('normalizes a v1 workbench into one panel-backed singleton page and launcher', () => {
    const legacy: WorkbenchManifest = {
      schemaVersion: 1,
      id: '@forgeax/wb-example',
      version: '1.0.0',
      kind: 'workbench',
      displayName: 'Example',
      entry: { frontend: './src/index.tsx' },
      provides: { workbench: { id: 'example', position: 9 } },
    };
    const normalized = normalizeManifest(legacy);
    expect(normalized.categories).toEqual(['workbench']);
    expect(normalized.contributes.pages?.[0]).toMatchObject({ id: 'example', cardinality: 'singleton' });
    expect(normalized.contributes.panelTypes?.[0]).toMatchObject({ id: 'example.content', runtime: 'inline' });
    expect(normalized.contributes.activities?.[0]).toMatchObject({ id: 'example.launcher', order: 9 });
    expect(parseAnyManifest(normalized).ok).toBe(true);
  });
});
