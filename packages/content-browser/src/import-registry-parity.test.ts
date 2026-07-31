import { describe, expect, it } from 'bun:test';
import { IMPORT_FORMATS as coreFormats } from '@forgeax/editor-core';
import { IMPORT_FORMATS as browserFormats } from './import-registry';

describe('import registry matrix parity', () => {
  it('keeps Content Browser selection and core execution on one format contract', () => {
    const normalize = (formats: typeof browserFormats) => formats.map((format) => ({
      extensions: format.extensions,
      importer: format.importer,
      subAssetKinds: format.subAssetKinds,
      defaultSettings: format.defaultSettings,
    }));
    expect(normalize(browserFormats)).toEqual(normalize(coreFormats));
  });
});
