import { describe, expect, it } from 'bun:test';
import {
  PageContributionsSchema,
  PageKeySchema,
  decodePageKey,
  encodePageKey,
  qualifyContributionId,
  resolveContributionRef,
} from '../src/page';

const extensionId = '@forgeax-plugin/example';
const pageTypeId = qualifyContributionId(extensionId, 'page', 'asset-editor');

describe('page contribution contracts', () => {
  it('accepts an empty contribution family', () => {
    expect(PageContributionsSchema.parse({})).toEqual({});
  });

  it('validates page composition and explicit cross-extension refs', () => {
    const parsed = PageContributionsSchema.parse({
      pages: [
        {
          id: 'asset-editor',
          title: { en: 'Asset editor' },
          cardinality: 'resource',
          restorePolicy: 'project',
          layout: {
            version: 2,
            root: {
              kind: 'split',
              direction: 'horizontal',
              sizes: [360, 840],
              children: [
                { kind: 'tabs', placements: ['preview'], active: 'preview' },
                { kind: 'tabs', placements: ['inspector'], active: 'inspector' },
              ],
            },
          },
          layoutVersion: 2,
          panels: [
            { id: 'preview', panelType: { extension: 'self', id: 'preview' } },
            {
              id: 'inspector',
              optional: true,
              panelType: { extension: '@forgeax-plugin/inspector', id: 'properties', version: '^1' },
            },
          ],
        },
      ],
    });

    expect(parsed.pages).toHaveLength(1);
  });

  it('rejects ids that could collide with qualified-id separators', () => {
    expect(() => qualifyContributionId(extensionId, 'page', 'asset/editor')).toThrow();
    expect(() => qualifyContributionId(extensionId, 'page', 'asset#editor')).toThrow();
  });

  it('resolves self and explicit cross-extension references without string guessing', () => {
    expect(resolveContributionRef(extensionId, 'panel', { extension: 'self', id: 'preview' })).toBe(
      `${extensionId}#panel/preview`,
    );
    expect(
      resolveContributionRef(extensionId, 'panel', {
        extension: '@forgeax-plugin/inspector',
        id: 'properties',
        version: '^1',
      }),
    ).toBe('@forgeax-plugin/inspector#panel/properties');
  });

  it('requires a meaningful resource selector', () => {
    expect(
      PageContributionsSchema.safeParse({
        resourceEditors: [
          { id: 'empty', selector: {}, pageType: { extension: 'self', id: 'asset-editor' } },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('PageKey canonical codec', () => {
  const cases = [
    { cardinality: 'singleton' as const, typeId: pageTypeId },
    { cardinality: 'resource' as const, typeId: pageTypeId, resourceId: 'asset://sprites/hero:idle.png' },
    { cardinality: 'multi-instance' as const, typeId: pageTypeId, instanceId: 'draft:2' },
  ];

  for (const key of cases) {
    it(`round-trips ${key.cardinality}`, () => {
      const parsed = PageKeySchema.parse(key);
      expect(decodePageKey(encodePageKey(parsed))).toEqual(parsed);
    });
  }

  it('rejects unknown codec versions', () => {
    expect(() => decodePageKey('page:v2:s:anything')).toThrow('unsupported page key');
  });
});
